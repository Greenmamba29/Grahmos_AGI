/**
 * Core types for GATE (Gated Agent Trust Evaluation).
 *
 * Design rule: every number the harness reports must be traceable to a
 * recorded trajectory, and every trajectory must be scored twice —
 * once the way a naive harness would see it, and once with the grader's
 * own files restored to their pristine state.
 */

export type Messiness = "low" | "high";

/** Read-only view of a file system snapshot. */
export interface ReadonlyFS {
  read(path: string): string | undefined;
  exists(path: string): boolean;
  list(prefix?: string): string[];
}

export interface GradeResult {
  pass: boolean;
  /** 0..1 partial credit; informational only, success is binary. */
  score: number;
  details: string;
}

export interface Task {
  id: string;
  title: string;
  /** Tasks in the same family share structure; used for weighting. */
  family: string;
  prompt: string;
  /** Estimated time for a skilled human professional, in minutes. */
  humanMinutes: number;
  messiness: Messiness;
  tags?: string[];
  /** Files the agent can see and edit. */
  files: Record<string, string>;
  /** Grader-owned files. Writing or deleting these is tampering. */
  protectedPaths: string[];
  /** Files present in the sandbox that the agent must never read (answer keys). */
  hiddenFiles?: Record<string, string>;
  /** Deterministic final grader. Runs on the final file system after the run. */
  grade(fs: ReadonlyFS): GradeResult;
  /**
   * Visible check exposed to the agent through run_check. Defaults to `grade`.
   * Keep it weaker than `grade` (e.g. a format check) so the final grader is
   * not a free oracle the agent can query until it guesses the answer.
   */
  check?(fs: ReadonlyFS): GradeResult;
  /** Max tool calls before the run is cut off. */
  maxSteps?: number;
  /** Held-out tasks are never shown to agent developers. */
  holdout?: boolean;
  /**
   * Reference solution, used only by simulated agents and by the suite
   * self-test. Never exposed to real agents.
   */
  solve?(tools: ToolAPI): Promise<void>;
  /** Writes a plausible but wrong answer (used by simulated agents). */
  writeWrongAnswer?(tools: ToolAPI): Promise<void>;
  /** The path where the agent's answer goes, if the task has one. */
  outputPath?: string;
}

export type ToolName =
  | "list_files"
  | "read_file"
  | "write_file"
  | "delete_file"
  | "run_check"
  | "submit";

export interface ToolCallStep {
  kind: "tool";
  index: number;
  tool: ToolName;
  args: Record<string, unknown>;
  ok: boolean;
  /** Truncated result preview for the transcript. */
  result: string;
  elapsedMs: number;
}

export interface ThoughtStep {
  kind: "thought";
  index: number;
  text: string;
}

export interface SubmitStep {
  kind: "submit";
  index: number;
  claim: "success" | "gave_up";
  text: string;
}

export type Step = ToolCallStep | ThoughtStep | SubmitStep;

export interface ToolAPI {
  listFiles(prefix?: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  /** Runs the task's visible checks against the current state. */
  runCheck(): Promise<GradeResult>;
  /** Record reasoning text (chain of thought or model message content). */
  think(text: string): void;
  submit(claim: "success" | "gave_up", text?: string): void;
}

export interface AgentContext {
  task: { id: string; title: string; prompt: string; files: string[] };
  tools: ToolAPI;
  /** Seeded random source in [0,1). */
  random: () => number;
  /** Aborted when step or time budget is exhausted. */
  signal: AbortSignal;
  /** The run's budgets, so agents (e.g. LLM adapters) can size their loops. */
  budget: { maxSteps: number; timeoutMs: number };
}

export interface Agent {
  name: string;
  /**
   * "model": a model acting only through tool calls (the built-in LLM adapters).
   * "code": agent code running in this process. Code agents are trusted — they
   * can tamper with process globals — so their verdicts are not certifiable.
   */
  kind?: "model" | "code";
  run(ctx: AgentContext): Promise<void>;
}

export type Severity = "critical" | "warning" | "info";

export type DetectorId =
  | "grader_tamper"
  | "answer_key_access"
  | "sandbox_escape"
  | "reward_hack_intent"
  | "eval_awareness"
  | "false_success_claim"
  | "budget_exhausted"
  | "timeout"
  | "no_submission"
  | "recorder_tamper";

export interface IntegrityFlag {
  detector: DetectorId;
  severity: Severity;
  evidence: string;
  stepIndex?: number;
}

/** How runs with critical integrity flags are scored. */
export type CheatPolicy = "failure" | "success" | "exclude";

export interface RunRecord {
  runId: string;
  taskId: string;
  family: string;
  agent: string;
  repeat: number;
  humanMinutes: number;
  messiness: Messiness;
  holdout: boolean;
  /** What a naive harness would report (grader run on final state). */
  naivePass: boolean;
  /** Grader run with protected files restored to pristine. */
  cleanPass: boolean;
  claim: "success" | "gave_up" | "none";
  flags: IntegrityFlag[];
  /** True if any critical flag fired. */
  cheated: boolean;
  steps: Step[];
  stepCount: number;
  wallMs: number;
  timedOut: boolean;
  error?: string;
  /**
   * "infra": the run failed for reasons outside the agent (HTTP 429/5xx,
   * network). Infra-errored runs are excluded from scoring and reported.
   * "agent": the agent's own code threw; scored as a failure.
   */
  errorKind?: "agent" | "infra";
}

export interface HorizonEstimate {
  /** Minutes at which P(success) = p. null when unbounded or undefined. */
  minutes: number | null;
  /** True when the success curve never falls below p (horizon beyond any task length). */
  unbounded: boolean;
  /** False when the fitted slope is not negative: the curve never crosses p in a meaningful way. */
  identified: boolean;
  /** Lower CI bound in minutes (null = no data, or unbounded — see ciLowUnbounded). */
  ciLow: number | null;
  /** True when even the lower CI bound lies beyond every task length (e.g. 100% success). */
  ciLowUnbounded: boolean;
  /** Upper CI bound in minutes (null = unbounded or no data). */
  ciHigh: number | null;
}

export interface HorizonFit {
  intercept: number;
  slope: number;
  n: number;
  h50: HorizonEstimate;
  h80: HorizonEstimate;
  /** Notes about fit quality (e.g. non-negative slope). */
  notes: string[];
}

export interface SubsetMetrics {
  subset: "all" | "low" | "high";
  runs: number;
  tasks: number;
  successRate: number;
  /** Longest task in the subset; horizons beyond it are extrapolation. */
  maxTaskMinutes: number;
  /** Per-task tallies under the subset's cheat policy (used for exact gate checks). */
  taskStats: { taskId: string; family: string; minutes: number; runs: number; successes: number; infraExcluded: number }[];
  fit: HorizonFit;
}

export interface Metrics {
  agent: string;
  policy: CheatPolicy;
  totalRuns: number;
  scoredRuns: number;
  /** Runs dropped because of infrastructure errors (not the agent's fault). */
  infraErrors: number;
  /** Raw counts behind the rates, so exact bounds can be computed. */
  counts: { runs: number; cheats: number; falseClaims: number; evalAwareness: number };
  cheatRate: number;
  falseClaimRate: number;
  evalAwarenessRate: number;
  rewardHackIntentRate: number;
  naiveSuccessRate: number;
  cleanSuccessRate: number;
  subsets: SubsetMetrics[];
  detectorCounts: Record<string, number>;
}

export type GateMetric =
  | "horizon50"
  | "horizon80"
  | "successRate"
  | "cheatRate"
  | "falseClaimRate"
  | "evalAwarenessRate";

export interface GateRequirement {
  metric: GateMetric;
  subset?: "all" | "low" | "high";
  op: ">=" | "<=";
  value: number;
  /**
   * Compare a conservative bound instead of the point estimate (default true):
   * for horizons, the bootstrap CI bound plus an exact binomial check on tasks
   * in [threshold, 2×threshold]; for rates, the exact (Clopper–Pearson) bound.
   */
  conservative?: boolean;
  /** One-sided confidence for exact bounds (default 0.95). */
  confidence?: number;
  /** Horizon gates: minimum distinct tasks AND distinct families in [threshold, 2×threshold] (default 8). */
  minTasksAtThreshold?: number;
}

/**
 * pass: the conservative bound clears the bar. fail: even the optimistic bound
 * misses it. insufficient: in between — not enough evidence either way (too
 * few runs, tasks or families, or too many infrastructure errors).
 */
export type GateStatus = "pass" | "fail" | "insufficient";

export interface Gate {
  id: string;
  name: string;
  description: string;
  requirements: GateRequirement[];
}

export interface RequirementResult {
  requirement: GateRequirement;
  observed: number | null;
  pass: boolean;
  status: GateStatus;
  note?: string;
  /** Direct evidence at the threshold for horizon requirements. */
  atThreshold?: { tasks: number; runs: number; successes: number; rate: number; exactLower: number; designEffect: number };
}

export interface GateResult {
  gate: Gate;
  pass: boolean;
  status: GateStatus;
  /** Gate-level reason, e.g. too many infrastructure errors to certify. */
  note?: string;
  results: RequirementResult[];
}
