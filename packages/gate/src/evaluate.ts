import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog, verifyAuditLog, type AuditEntry, type VerifyResult } from "./audit.js";
import type { DetectorOptions } from "./detectors.js";
import { renderHTML, renderMarkdown, type AgentReport, type ReportInput } from "./report.js";
import { freezeTask, runOnce, runSuite, trajectoryHash } from "./runner.js";
import { isUnder, normalizePath } from "./sandbox.js";
import { computeMetrics, DEFAULT_GATES, evaluateGates } from "./scoring.js";
import { CHECK_PATH, KEY_PATH } from "./suites/define.js";
import { ScriptedAgent } from "./agents/simulated.js";
import type { Agent, Gate, RunRecord, Step, Task } from "./types.js";
import { canonicalJSON, jsonReplacer, sha256 } from "./util.js";
import { HARNESS_VERSION } from "./version.js";

export interface EvaluateOptions {
  tasks: Task[];
  agents: Agent[];
  suiteName: string;
  repeats?: number;
  seed?: number;
  gates?: Gate[];
  bootstrap?: number;
  ridge?: number;
  hmacKey?: string;
  maxSteps?: number;
  timeoutMs?: number;
  skipHoldout?: boolean;
  detector?: DetectorOptions;
  /** If set, writes results.json, report.md, report.html and audit.jsonl here. */
  outDir?: string;
  title?: string;
  notes?: string[];
  onRun?: (r: RunRecord) => void;
}

export interface EvaluateResult {
  report: ReportInput;
  records: RunRecord[];
  audit: AuditLog;
  markdown: string;
  html: string;
}

const ARTIFACTS = ["results.json", "report.md", "report.html"] as const;

/** Picks evidence for the report: critical flags first, then warnings, one run per task. */
function pickExamples(recs: RunRecord[], n = 6): RunRecord[] {
  const rank = (r: RunRecord) => (r.flags.some((f) => f.severity === "critical") ? 0 : r.flags.some((f) => f.severity === "warning") ? 1 : 2);
  const seen = new Set<string>();
  const out: RunRecord[] = [];
  for (const r of [...recs].filter((r) => rank(r) < 2).sort((a, b) => rank(a) - rank(b))) {
    if (seen.has(r.taskId)) continue;
    seen.add(r.taskId);
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

export async function evaluate(o: EvaluateOptions): Promise<EvaluateResult> {
  const seed = o.seed ?? 0;
  const repeats = o.repeats ?? 1;
  const bootstrap = o.bootstrap ?? 500;
  const gates = o.gates ?? DEFAULT_GATES;
  let auditPath: string | undefined;
  if (o.outDir) {
    mkdirSync(o.outDir, { recursive: true });
    auditPath = join(o.outDir, "audit.jsonl");
    rmSync(auditPath, { force: true });
  }
  const audit = new AuditLog({ hmacKey: o.hmacKey, filePath: auditPath });
  audit.append("evaluation_start", {
    harness: HARNESS_VERSION,
    chain: o.hmacKey ? "hmac-sha256" : "sha256",
    suite: o.suiteName,
    agents: o.agents.map((a) => ({ name: a.name, kind: a.kind ?? "code" })),
    repeats,
    seed,
    bootstrap,
    ridge: o.ridge ?? 0.1,
    policy: "failure",
    sealed: Boolean(o.outDir),
    gates,
  });

  // Freeze the suite once, so no agent (code agents run in-process) can change how a later agent is graded.
  const tasks = o.tasks.map(freezeTask);
  const mixed = o.agents.some((a) => (a.kind ?? "code") === "code") && o.agents.some((a) => a.kind === "model");
  const records: RunRecord[] = [];
  const agentReports: AgentReport[] = [];
  for (const agent of o.agents) {
    let recs: RunRecord[];
    try {
      recs = await runSuite(tasks, agent, { repeats, seed, audit, maxSteps: o.maxSteps, timeoutMs: o.timeoutMs, skipHoldout: o.skipHoldout, detector: o.detector, onRun: o.onRun });
    } catch (e) {
      // Leave an explicit marker so a partial folder is never mistaken for a finished evaluation.
      audit.append("evaluation_aborted", { agent: agent.name, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      throw e;
    }
    records.push(...recs);
    const integrity = computeMetrics(recs, "failure", { bootstrap, seed, ridge: o.ridge });
    const naive = computeMetrics(recs, "success", { bootstrap, seed, ridge: o.ridge });
    const gateResults = evaluateGates(integrity, gates);
    if (mixed && agent.kind === "model") {
      // Code agents share this process; a model agent's verdicts are only certifiable in an evaluation of its own.
      for (const g of gateResults) {
        g.note = `${g.note ? `${g.note}; ` : ""}evaluated alongside in-process code agents; re-run this model agent on its own to certify`;
        if (g.status === "pass") {
          g.status = "insufficient";
          g.pass = false;
        }
      }
    }
    audit.append("metrics", {
      agent: agent.name,
      runs: integrity.counts.runs,
      infraErrors: integrity.infraErrors,
      h50: integrity.subsets[0]!.fit.h50,
      h80: integrity.subsets[0]!.fit.h80,
      h80High: integrity.subsets[2]!.fit.h80,
      counts: integrity.counts,
      naiveH50: naive.subsets[0]!.fit.h50,
      gates: gateResults.map((g) => ({ id: g.gate.id, status: g.status, results: g.results.map((r) => ({ metric: r.requirement.metric, observed: r.observed, status: r.status })) })),
    });
    agentReports.push({ agent: agent.name, kind: agent.kind ?? "code", integrity, naive, gates: gateResults, examples: pickExamples(recs) });
  }
  audit.append("evaluation_end", { runs: records.length, recordsSha256: sha256(canonicalJSON(records.map(recordDigest))) });

  const selfCheck = verifyAuditLog(audit.toJSONL(), o.hmacKey, { requireLastType: ["evaluation_end"] }).ok;
  const report: ReportInput = {
    title: o.title ?? "GATE evaluation report",
    suite: o.suiteName,
    generatedAt: new Date().toISOString(),
    seed,
    repeats,
    harness: HARNESS_VERSION,
    audit: { entries: audit.entries.length, head: audit.head, verified: selfCheck, hmac: Boolean(o.hmacKey) },
    agents: agentReports,
    notes: o.notes,
  };
  const markdown = renderMarkdown(report);
  const html = renderHTML(report);

  if (o.outDir) {
    const results = JSON.stringify({ report, records }, jsonReplacer, 2);
    writeFileSync(join(o.outDir, "results.json"), results);
    writeFileSync(join(o.outDir, "report.md"), markdown);
    writeFileSync(join(o.outDir, "report.html"), html);
    // Seal the written files into the chain.
    const files: Record<string, string> = {};
    for (const f of ARTIFACTS) files[f] = sha256(readFileSync(join(o.outDir, f), "utf8"));
    audit.append("artifacts", { files });
  }
  return { report, records, audit, markdown, html };
}

/** Fields of a run that the audit log commits to. */
function recordDigest(r: RunRecord) {
  return { runId: r.runId, naivePass: r.naivePass, cleanPass: r.cleanPass, claim: r.claim, cheated: r.cheated, trajectorySha256: trajectoryHash(r) };
}

export interface EvidenceCheck {
  audit: VerifyResult;
  problems: string[];
  /** What was actually checked, for the verifier's output. */
  checked: string[];
  ok: boolean;
}

/**
 * Verifies an output folder as a whole: the audit chain is intact and ends
 * with the `artifacts` seal; results.json, report.md and report.html match
 * their sealed hashes; every run in results.json matches the transcript hash
 * and outcome logged for it; and the records digest matches. With
 * `recompute`, metrics and gate verdicts are re-derived from the records
 * using the logged configuration and compared with the logged verdicts.
 */
export function verifyEvidence(dir: string, hmacKey?: string, opts: { requireHmac?: boolean; expectHead?: string; recompute?: boolean } = {}): EvidenceCheck {
  const problems: string[] = [];
  const checked: string[] = [];
  const auditText = readFileSync(join(dir, "audit.jsonl"), "utf8");
  // A folder is always expected to be sealed: never infer that from which files happen to exist.
  const audit = verifyAuditLog(auditText, hmacKey, { requireHmac: opts.requireHmac, expectHead: opts.expectHead, requireLastType: ["artifacts"] });
  if (!audit.ok) return { audit, problems: [audit.reason ?? "audit chain invalid"], checked, ok: false };
  checked.push(`audit chain (${audit.count} entries, ${hmacKey ? "HMAC" : "unkeyed"}) ends with the artifacts seal`);

  const entries = auditText
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditEntry);
  const art = entries.at(-1)!.payload as { files: Record<string, string> };
  for (const f of ARTIFACTS) {
    const p = join(dir, f);
    if (art.files?.[f] === undefined) problems.push(`${f} is not in the artifacts seal`);
    else if (!existsSync(p)) problems.push(`${f} is missing`);
    else if (sha256(readFileSync(p, "utf8")) !== art.files[f]) problems.push(`${f} does not match the hash sealed in the audit log`);
  }
  checked.push(`sealed hashes of ${ARTIFACTS.join(", ")}`);
  if (!existsSync(join(dir, "results.json"))) return { audit, problems, checked, ok: false };

  const { records } = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as { records: RunRecord[] };
  const logged = new Map<string, Record<string, unknown>>();
  for (const e of entries) if (e.type === "run") logged.set(String((e.payload as { runId: string }).runId), e.payload as Record<string, unknown>);
  if (logged.size !== records.length) problems.push(`audit log has ${logged.size} runs, results.json has ${records.length}`);
  for (const r of records) {
    const l = logged.get(r.runId);
    if (!l) {
      problems.push(`run ${r.runId} is not in the audit log`);
      continue;
    }
    if (l.trajectorySha256 !== trajectoryHash({ steps: r.steps as Step[] })) problems.push(`run ${r.runId}: transcript differs from the logged hash`);
    for (const k of ["naivePass", "cleanPass", "claim", "cheated"] as const) {
      if (l[k] !== r[k]) problems.push(`run ${r.runId}: ${k} is ${String(r[k])} in results.json but ${String(l[k])} in the audit log`);
    }
  }
  checked.push(`${records.length} run transcripts and outcomes against the log`);
  // Every agent must have been run against the identical suite (grader source included).
  const specs = entries.filter((e) => e.type === "suite_start").map((e) => JSON.stringify((e.payload as { tasks: { id: string; specSha256: string }[] }).tasks.map((t) => [t.id, t.specSha256])));
  if (new Set(specs).size > 1) problems.push("task specifications differ between agents' suite_start entries (the suite changed mid-evaluation)");
  else checked.push("identical task specifications for every agent");
  const end = entries.find((e) => e.type === "evaluation_end")?.payload as { recordsSha256?: string } | undefined;
  if (!end || end.recordsSha256 !== sha256(canonicalJSON(records.map(recordDigest)))) problems.push("records digest does not match evaluation_end");
  else checked.push("records digest");

  if (opts.recompute) {
    const start = entries[0]!.payload as { seed: number; bootstrap: number; ridge: number; gates: Gate[]; agents: { name: string; kind: string }[] };
    const kinds = new Map(start.agents.map((x) => [x.name, x.kind]));
    const mixed = [...kinds.values()].includes("code") && [...kinds.values()].includes("model");
    const metricsEntries = entries.filter((e) => e.type === "metrics").map((e) => e.payload as { agent: string; gates: { id: string; status: string }[] });
    for (const me of metricsEntries) {
      const recs = records.filter((r) => r.agent === me.agent);
      const m = computeMetrics(recs, "failure", { bootstrap: start.bootstrap, seed: start.seed, ridge: start.ridge });
      const verdicts = evaluateGates(m, start.gates);
      for (const g of verdicts) {
        if (mixed && kinds.get(me.agent) === "model" && g.status === "pass") g.status = "insufficient";
        const loggedStatus = me.gates.find((x) => x.id === g.gate.id)?.status;
        if (loggedStatus !== g.status) problems.push(`${me.agent} gate ${g.gate.id}: recomputed ${g.status}, logged ${String(loggedStatus)}`);
      }
    }
    checked.push(`recomputed metrics and gate verdicts for ${metricsEntries.length} agent(s)`);
  }
  return { audit, problems, checked, ok: problems.length === 0 };
}

export interface SelfTestIssue {
  taskId: string;
  problem: string;
}

/**
 * Validates a suite before it is trusted: the reference solution must pass,
 * a wrong answer must fail, every grader-owned file must be tamper-detected
 * and restored, and answer-key reads must be caught.
 */
export async function selfTest(tasks: Task[]): Promise<SelfTestIssue[]> {
  const issues: SelfTestIssue[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) issues.push({ taskId: t.id, problem: "duplicate task id" });
    ids.add(t.id);
    if (!(t.humanMinutes > 0)) issues.push({ taskId: t.id, problem: "humanMinutes must be > 0" });
    const protectedFiles = Object.keys(t.files).filter((f) => isUnder(normalizePath(f), t.protectedPaths));
    if (t.protectedPaths.length === 0 || protectedFiles.length === 0) issues.push({ taskId: t.id, problem: "no grader-owned files under protectedPaths" });

    // Every grader-owned file: overwriting it must be flagged, and the clean grade must ignore the change.
    for (const f of protectedFiles) {
      const tamper = new ScriptedAgent("selftest:tamper-file", async ({ tools }) => {
        await tools.writeFile(f, "tampered\n");
        tools.submit("gave_up");
      });
      const r = await runOnce(t, tamper, 0);
      if (!r.cheated) issues.push({ taskId: t.id, problem: `overwriting grader file ${f} is not detected` });
    }
    for (const k of Object.keys(t.hiddenFiles ?? {})) {
      const peek = new ScriptedAgent("selftest:read-key", async ({ tools }) => {
        await tools.readFile(k);
        tools.submit("gave_up");
      });
      if (!(await runOnce(t, peek, 0)).cheated) issues.push({ taskId: t.id, problem: `reading hidden file ${k} is not detected` });
    }

    if (!t.solve || !t.writeWrongAnswer || !t.outputPath) {
      issues.push({ taskId: t.id, problem: "no reference solution / wrong answer; correctness checks skipped" });
      continue;
    }
    const solver = new ScriptedAgent("selftest:solve", async ({ tools }) => {
      await t.solve!(tools);
      tools.submit("success");
    });
    const r1 = await runOnce(t, solver, 0);
    if (!r1.naivePass || !r1.cleanPass) issues.push({ taskId: t.id, problem: `reference solution fails the grader (${r1.error ?? "no error"})` });
    if (r1.flags.length > 0) issues.push({ taskId: t.id, problem: `reference solution raises flags: ${r1.flags.map((f) => f.detector).join(", ")}` });

    const wrong = new ScriptedAgent("selftest:wrong", async ({ tools }) => {
      await t.writeWrongAnswer!(tools);
      tools.submit("gave_up");
    });
    const r2 = await runOnce(t, wrong, 0);
    if (r2.naivePass) issues.push({ taskId: t.id, problem: "wrong answer passes the grader (check is too weak)" });

    // Hash-check tasks: a tamper that makes the naive grader pass must fail once grader files are restored.
    if (t.files[CHECK_PATH] !== undefined) {
      const tamper = new ScriptedAgent("selftest:tamper-hash", async ({ tools }) => {
        await t.writeWrongAnswer!(tools);
        const out = await tools.readFile(t.outputPath!);
        await tools.writeFile(CHECK_PATH, `${sha256(canonicalJSON(JSON.parse(out)))}\n`);
        tools.submit("success");
      });
      const r3 = await runOnce(t, tamper, 0);
      if (!r3.naivePass) issues.push({ taskId: t.id, problem: "hash tamper probe did not fool the naive grader (probe is stale)" });
      if (r3.cleanPass) issues.push({ taskId: t.id, problem: "restored grader still passes a tampered run" });
    }
    if (t.hiddenFiles?.[KEY_PATH] !== undefined) {
      const key = new ScriptedAgent("selftest:key", async ({ tools }) => {
        await tools.writeFile(t.outputPath!, await tools.readFile(KEY_PATH));
        tools.submit("success");
      });
      if (!(await runOnce(t, key, 0)).cheated) issues.push({ taskId: t.id, problem: "copying the answer key is not detected" });
    }
  }
  return issues;
}
