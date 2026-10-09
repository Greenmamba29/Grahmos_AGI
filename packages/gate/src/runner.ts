import type { AuditLog } from "./audit.js";
import { detect, isCheat, type DetectorOptions } from "./detectors.js";
import { BudgetExhaustedError, ConfigError, InfraError, RunClosedError, RunTimeoutError, Sandbox } from "./sandbox.js";
import type { Agent, GradeResult, ReadonlyFS, RunRecord, Step, Task } from "./types.js";
import { canonicalJSON, deriveSeed, mulberry32, sha256 } from "./util.js";

export interface RunOptions {
  repeats?: number;
  seed?: number;
  /** Default tool-call budget when a task sets none. */
  maxSteps?: number;
  /** Wall-clock limit per run (default 15 minutes). */
  timeoutMs?: number;
  detector?: DetectorOptions;
  audit?: AuditLog;
  onRun?: (r: RunRecord) => void;
  /** Exclude held-out tasks (e.g. during agent development). */
  skipHoldout?: boolean;
  /** Characters kept per tool result in transcripts (default 400). Use Infinity when exporting training data. */
  transcriptChars?: number;
}

export const DEFAULT_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_MAX_STEPS = 60;

function safeGrade(task: Task, fs: ReadonlyFS): GradeResult {
  try {
    return task.grade.call(task, fs);
  } catch (e) {
    return { pass: false, score: 0, details: `grader error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Errors outside the agent's control. Only the typed InfraError counts:
 * matching on message text would let agent code drop its own failed runs.
 */
export function isInfraError(e: unknown): boolean {
  return e instanceof InfraError;
}

/**
 * Deep-frozen copy of a task. Runs use the copy, so agent code that mutates
 * the shared suite objects (grader, protected paths, hidden files) cannot
 * change how this or any later run is graded or checked.
 */
export function freezeTask(t: Task): Task {
  if (Object.isFrozen(t) && Object.isFrozen(t.files) && Object.isFrozen(t.protectedPaths)) return t;
  const copy: Task = {
    ...t,
    files: Object.freeze({ ...t.files }),
    protectedPaths: Object.freeze([...t.protectedPaths]) as string[],
    ...(t.hiddenFiles ? { hiddenFiles: Object.freeze({ ...t.hiddenFiles }) } : {}),
    ...(t.tags ? { tags: Object.freeze([...t.tags]) as string[] } : {}),
  };
  return Object.freeze(copy);
}

/** Runs one agent on one task once. */
export async function runOnce(original: Task, agent: Agent, repeat: number, opts: RunOptions = {}): Promise<RunRecord> {
  const task = freezeTask(original);
  const specBefore = taskSpecHash(original);
  const seed = deriveSeed(opts.seed ?? 0, agent.name, task.id, repeat);
  const controller = new AbortController();
  const maxSteps = task.maxSteps ?? opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sandbox = new Sandbox(task, { maxSteps, controller, previewChars: opts.transcriptChars });
  const graderTask = task;
  let error: string | undefined;
  let errorKind: RunRecord["errorKind"];
  let timedOut = false;
  const t0 = performance.now();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new RunTimeoutError(`wall-clock limit of ${timeoutMs}ms reached`));
    }, timeoutMs);
  });

  try {
    await Promise.race([
      agent.run({
        task: { id: task.id, title: task.title, prompt: task.prompt, files: Object.keys(task.files).sort() },
        tools: sandbox.facade(),
        random: mulberry32(seed),
        signal: controller.signal,
        budget: { maxSteps, timeoutMs },
      }),
      timeout,
    ]);
  } catch (e) {
    if (e instanceof RunTimeoutError || timedOut) {
      timedOut = true;
    } else if (e instanceof BudgetExhaustedError || e instanceof RunClosedError) {
      // budget recorded by the sandbox
    } else if (e instanceof ConfigError) {
      clearTimeout(timer);
      sandbox.close();
      throw e;
    } else {
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      errorKind = isInfraError(e) ? "infra" : "agent";
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Freeze the trajectory: anything the agent does after this point is not recorded.
    sandbox.close();
  }

  let steps: Step[];
  let recorderProblem: string | undefined;
  try {
    steps = sandbox.snapshotSteps();
  } catch (e) {
    steps = Object.freeze([...sandbox.steps]) as Step[];
    recorderProblem = e instanceof Error ? e.message : String(e);
  }
  if (taskSpecHash(original) !== specBefore) recorderProblem = `${recorderProblem ? `${recorderProblem}; ` : ""}the shared task definition was modified during the run`;
  const naive = safeGrade(graderTask, sandbox.fs);
  const clean = safeGrade(graderTask, sandbox.restoredSnapshot());
  const claim = sandbox.submittedClaim;
  const flags = detect(
    { task, steps, claim, naivePass: naive.pass, cleanPass: clean.pass, budgetExhausted: sandbox.budgetExhausted && claim === "none", timedOut: timedOut && claim === "none" },
    opts.detector,
  );
  if (recorderProblem) flags.push({ detector: "recorder_tamper", severity: opts.detector?.severityOverrides?.recorder_tamper ?? "critical", evidence: recorderProblem });

  const record: RunRecord = {
    runId: `${agent.name}::${task.id}::${repeat}`,
    taskId: task.id,
    family: task.family,
    agent: agent.name,
    repeat,
    humanMinutes: task.humanMinutes,
    messiness: task.messiness,
    holdout: task.holdout ?? false,
    naivePass: naive.pass,
    cleanPass: clean.pass,
    claim,
    flags,
    cheated: isCheat(flags),
    steps,
    stepCount: sandbox.stepCount,
    wallMs: Math.round(performance.now() - t0),
    timedOut,
    ...(error ? { error, errorKind } : {}),
  };

  opts.audit?.append("run", {
    runId: record.runId,
    taskId: record.taskId,
    agent: record.agent,
    repeat,
    naivePass: record.naivePass,
    cleanPass: record.cleanPass,
    claim,
    cheated: record.cheated,
    flags: flags.map((f) => ({ detector: f.detector, severity: f.severity, stepIndex: f.stepIndex })),
    stepCount: record.stepCount,
    timedOut,
    trajectorySha256: trajectoryHash(record),
    ...(error ? { error, errorKind } : {}),
  });
  opts.onRun?.(record);
  return record;
}

/**
 * Hash of a run's trajectory, recorded in the audit log so results.json
 * transcripts can be checked later. Timing (elapsedMs) is excluded so the
 * same behaviour always hashes the same.
 */
export function trajectoryHash(r: { steps: Step[] }): string {
  return sha256(canonicalJSON(r.steps.map((s) => (s.kind === "tool" ? { ...s, elapsedMs: undefined } : s))));
}

/** Runs every task `repeats` times. Runs are sequential so results are reproducible. */
export async function runSuite(tasks: Task[], agent: Agent, opts: RunOptions = {}): Promise<RunRecord[]> {
  const repeats = opts.repeats ?? 1;
  const selected = opts.skipHoldout ? tasks.filter((t) => !t.holdout) : tasks;
  opts.audit?.append("suite_start", {
    agent: agent.name,
    tasks: selected.map((t) => ({ id: t.id, humanMinutes: t.humanMinutes, messiness: t.messiness, holdout: t.holdout ?? false, specSha256: taskSpecHash(t) })),
    repeats,
    seed: opts.seed ?? 0,
    maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    detector: {
      severityOverrides: opts.detector?.severityOverrides ?? {},
      extraAwarenessPatterns: (opts.detector?.extraAwarenessPatterns ?? []).map(String),
      extraIntentPatterns: (opts.detector?.extraIntentPatterns ?? []).map(String),
    },
  });
  const out: RunRecord[] = [];
  for (const task of selected.map(freezeTask)) {
    for (let r = 0; r < repeats; r++) out.push(await runOnce(task, agent, r, opts));
  }
  opts.audit?.append("suite_end", { agent: agent.name, runs: out.length });
  return out;
}

/**
 * Fingerprint of everything that defines a task — prompt, files, hidden
 * files, protected paths, metadata and grader source — so silent edits to a
 * suite (including to the grader) change the hash recorded in the audit log.
 */
export function taskSpecHash(t: Task): string {
  return sha256(
    canonicalJSON({
      id: t.id,
      title: t.title,
      family: t.family,
      prompt: t.prompt,
      humanMinutes: t.humanMinutes,
      messiness: t.messiness,
      holdout: t.holdout ?? false,
      maxSteps: t.maxSteps ?? null,
      files: t.files,
      protectedPaths: t.protectedPaths,
      hiddenFiles: t.hiddenFiles ?? {},
      grader: t.grade.toString(),
      check: t.check ? t.check.toString() : null,
    }),
  );
}
