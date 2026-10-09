#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AnthropicAgent, OpenAIChatAgent, type LLMAgentOptions } from "../src/agents/llm.js";
import { PROFILES, simulatedAgent } from "../src/agents/simulated.js";
import { verifyAuditLog } from "../src/audit.js";
import { evaluate, selfTest, verifyEvidence } from "../src/evaluate.js";
import { calibrate } from "../src/calibrate.js";
import { DEFAULT_GATES, validateGates } from "../src/scoring.js";
import { exampleSuite } from "../src/suites/example.js";
import type { Agent, HorizonEstimate, Task } from "../src/types.js";
import { formatMinutes } from "../src/util.js";
import { HARNESS_VERSION } from "../src/version.js";

const HELP = `gate — Gated Agent Trust Evaluation (${HARNESS_VERSION})

Usage:
  gate run --agent <spec> [--agent <spec>...] [options]
  gate demo [--out runs/demo]
  gate self-test [--suite example|<path>]
  gate calibrate [--gate S1] [--sims 50] [--repeats 12] [--slope 1] [--task-sd 0] [--multiples 0.75,1,2,4]
  gate list-tasks [--suite example|<path>]
  gate verify <output-dir> [--no-recompute] [--require-hmac] [--expect-head <hash>] [--allow-unkeyed]
  gate verify <audit.jsonl> [--allow-partial] [--require-hmac] [--expect-head <hash>] [--allow-unkeyed]

Agent specs:
  sim:<profile>          simulated agent (${Object.keys(PROFILES).join(", ")})
  openai:<model>         OpenAI-compatible endpoint; env OPENAI_BASE_URL, OPENAI_API_KEY
                         (works with vLLM / Ollama / LM Studio / llama.cpp for offline evals)
  anthropic:<model>      Anthropic Messages API; env ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL

Run options:
  --suite <name|path>    built-in "example" or a module exporting \`suite\` or default Task[]
  --repeats <n>          runs per task (default 4; demo 12)
  --seed <n>             base seed (default 1)
  --out <dir>            output folder (default runs/<timestamp>)
  --bootstrap <n>        bootstrap resamples for intervals (default 500)
  --gates <file.json>    custom gate definitions (default: S0, S1, S2-proxy)
  --max-steps <n>        tool-call budget per run when a task sets none (default 60)
  --timeout-ms <n>       wall-clock limit per run (default 900000 = 15 min)
  --skip-holdout         leave out held-out tasks
  --title <text>         report title

LLM options:
  --temperature <x>      sampling temperature (omitted unless set)
  --max-turns <n>        model turns per run (default: the run's step budget)
  --max-tokens <n>       output tokens per turn (default 4096)
  --token-param <name>   max_tokens | max_completion_tokens (OpenAI; newer OpenAI models need the latter)
  --thinking-budget <n>  Anthropic extended thinking budget, so detectors can read reasoning

Env:
  GATE_AUDIT_KEY         HMAC key for the audit chain (recommended; verify with --require-hmac)
`;

interface Args {
  _: string[];
  flags: Record<string, string[]>;
}
function parse(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const val = next !== undefined && !next.startsWith("--") ? (i++, next) : "true";
      (out.flags[key] ??= []).push(val);
    } else out._.push(a);
  }
  return out;
}
const one = (a: Args, k: string, d?: string) => a.flags[k]?.at(-1) ?? d;

/** Parses a numeric flag, failing loudly instead of silently producing NaN. */
function num(a: Args, k: string, d: number | undefined, opts: { int?: boolean; min?: number } = {}): number | undefined {
  const raw = one(a, k);
  if (raw === undefined) return d;
  const v = Number(raw);
  if (!Number.isFinite(v) || (opts.int && !Number.isInteger(v)) || (opts.min !== undefined && v < opts.min)) {
    throw new Error(`--${k} must be ${opts.int ? "an integer" : "a number"}${opts.min !== undefined ? ` ≥ ${opts.min}` : ""}, got "${raw}"`);
  }
  return v;
}

async function loadSuite(spec: string): Promise<Task[]> {
  if (spec === "example") return exampleSuite;
  const mod = await import(pathToFileURL(resolve(spec)).href);
  const suite = (mod.suite ?? mod.default) as Task[] | undefined;
  if (!Array.isArray(suite)) throw new Error(`${spec} must export \`suite\` or a default Task[]`);
  return suite;
}

function makeAgent(spec: string, tasks: Task[], a: Args): Agent {
  const [kind, ...rest] = spec.split(":");
  const id = rest.join(":");
  const llm: Omit<LLMAgentOptions, "model"> = {
    temperature: num(a, "temperature", undefined, { min: 0 }),
    maxTurns: num(a, "max-turns", undefined, { int: true, min: 1 }),
    maxTokens: num(a, "max-tokens", undefined, { int: true, min: 1 }),
    thinkingBudget: num(a, "thinking-budget", undefined, { int: true, min: 1024 }),
  };
  const tp = one(a, "token-param");
  if (tp !== undefined) {
    if (tp !== "max_tokens" && tp !== "max_completion_tokens") throw new Error(`--token-param must be max_tokens or max_completion_tokens`);
    llm.tokenParam = tp;
  }
  if (kind === "sim") return simulatedAgent(id, tasks);
  if (kind === "openai") return new OpenAIChatAgent({ ...llm, model: id, baseUrl: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY });
  if (kind === "anthropic") return new AnthropicAgent({ ...llm, model: id, baseUrl: process.env.ANTHROPIC_BASE_URL, apiKey: process.env.ANTHROPIC_API_KEY });
  throw new Error(`unknown agent spec "${spec}"`);
}

const hz = (e: HorizonEstimate) => (!e.identified ? "n/id" : e.unbounded ? "> all" : formatMinutes(e.minutes));

async function runCmd(a: Args, demo: boolean) {
  const suiteName = one(a, "suite", "example")!;
  const tasks = await loadSuite(suiteName);
  const specs = demo ? ["sim:honest-junior", "sim:frontier", "sim:reward-hacker", "sim:reliable-workday"] : a.flags.agent ?? [];
  if (specs.length === 0) throw new Error("at least one --agent is required");
  const agents = specs.map((s) => makeAgent(s, tasks, a));
  const repeats = num(a, "repeats", demo ? 12 : 4, { int: true, min: 1 })!;
  const out = one(a, "out", demo ? "runs/demo" : `runs/${new Date().toISOString().replace(/[:.]/g, "-")}`)!;
  const gatesFile = one(a, "gates");
  const gates = gatesFile ? validateGates(JSON.parse(readFileSync(gatesFile, "utf8"))) : undefined;
  let n = 0;
  const total = agents.length * tasks.length * repeats;
  const res = await evaluate({
    tasks,
    agents,
    suiteName,
    repeats,
    seed: num(a, "seed", 1, { int: true }),
    bootstrap: num(a, "bootstrap", 500, { int: true, min: 0 }),
    gates,
    maxSteps: num(a, "max-steps", undefined, { int: true, min: 1 }),
    timeoutMs: num(a, "timeout-ms", undefined, { int: true, min: 1 }),
    skipHoldout: one(a, "skip-holdout") === "true",
    hmacKey: process.env.GATE_AUDIT_KEY,
    outDir: out,
    title: one(a, "title", demo ? "GATE demo — simulated agents with known ground truth" : undefined),
    notes: demo
      ? [
          "Demo run with simulated agents whose true horizons and cheat rates are set in code. It shows what the harness measures; it is not a measurement of any real model.",
          "Example-suite human times are illustrative placeholders, not calibrated baselines.",
        ]
      : undefined,
    onRun: () => {
      n++;
      if (process.stderr.isTTY) process.stderr.write(`\r  ${n}/${total} runs`);
    },
  });
  if (process.stderr.isTTY) process.stderr.write("\n");
  for (const ag of res.report.agents) {
    const all = ag.integrity.subsets[0]!.fit;
    console.log(
      `${ag.agent.padEnd(24)} h50 ${hz(all.h50).padStart(6)}  h80 ${hz(all.h80).padStart(6)}  cheat ${(ag.integrity.cheatRate * 100).toFixed(1).padStart(5)}%  naive h50 ${hz(ag.naive.subsets[0]!.fit.h50).padStart(6)}  gates ${ag.gates.map((g) => `${g.gate.id}:${g.status}`).join(" ")}`,
    );
  }
  console.log(`\nWrote ${out}/{report.html,report.md,results.json,audit.jsonl}.`);
  console.log(`Final audit head (anchor this somewhere you control): ${res.audit.head}`);
  console.log(`Check the folder with: gate verify ${out}${process.env.GATE_AUDIT_KEY ? " --require-hmac" : ""} --expect-head ${res.audit.head}`);
}

function verifyCmd(a: Args) {
  const target = a._[1];
  if (!target) throw new Error("usage: gate verify <output-dir | audit.jsonl>");
  const key = process.env.GATE_AUDIT_KEY;
  const opts = { requireHmac: one(a, "require-hmac") === "true", expectHead: one(a, "expect-head") };
  const unanchored = !key && !opts.expectHead;
  const allowUnkeyed = one(a, "allow-unkeyed") === "true";
  const caveat = unanchored
    ? `\n${allowUnkeyed ? "WARNING" : "NOT CERTIFIED"}: unkeyed check with no --expect-head. This proves internal consistency only; anyone can rebuild an unkeyed chain. Set GATE_AUDIT_KEY (with --require-hmac) or pass the head you anchored${allowUnkeyed ? "." : ", or pass --allow-unkeyed to accept a consistency-only check."}`
    : "";
  // Scripts read the exit code: an unanchored, unkeyed pass is not a pass unless explicitly allowed.
  const finish = (ok: boolean) => {
    if (!ok || (unanchored && !allowUnkeyed)) process.exitCode = 1;
  };
  if (statSync(target).isDirectory()) {
    // Recompute by default: without it, a verdict edited consistently in results.json and the log would pass.
    const r = verifyEvidence(target, key, { ...opts, recompute: one(a, "no-recompute") !== "true" });
    console.log(r.ok ? "OK" : "FAILED");
    console.log("  checks run:");
    for (const c of r.checked) console.log(`    · ${c}`);
    if (r.problems.length) console.log("  problems:");
    for (const p of r.problems) console.log(`    ✗ ${p}`);
    if (r.ok) console.log(`  head ${r.audit.head}${caveat}`);
    finish(r.ok);
    return;
  }
  const text = readFileSync(target, "utf8");
  // A log from a run that wrote files must end with the artifacts seal; otherwise evaluation_end.
  let sealed = false;
  try {
    sealed = Boolean((JSON.parse(text.split("\n")[0] ?? "{}") as { payload?: { sealed?: boolean } }).payload?.sealed);
  } catch {
    /* reported by the chain check */
  }
  const partial = one(a, "allow-partial") === "true";
  const r = verifyAuditLog(text, key, { ...opts, ...(partial ? {} : { requireLastType: sealed ? ["artifacts"] : ["evaluation_end", "artifacts"] }) });
  if (r.ok) console.log(`OK: ${r.count} entries, head ${r.head}, last entry "${r.lastType}"${key ? " (HMAC)" : ""}${partial ? " (partial log accepted)" : ""}${caveat}`);
  else console.log(`BROKEN${r.brokenAt !== undefined ? ` at entry ${r.brokenAt}` : ""}: ${r.reason}`);
  finish(r.ok);
}

async function calibrateCmd(a: Args) {
  const id = one(a, "gate", "S1")!;
  const gate = DEFAULT_GATES.find((g) => g.id === id);
  if (!gate) throw new Error(`unknown gate ${id}; built-in gates: ${DEFAULT_GATES.map((g) => g.id).join(", ")}`);
  const multiples = (one(a, "multiples", "0.75,1,2,4") ?? "").split(",").map(Number);
  if (multiples.some((x) => !(x > 0))) throw new Error("--multiples must be positive numbers, e.g. 0.75,1,2,4");
  const { rows } = await calibrate({
    gate,
    multiples,
    sims: num(a, "sims", 50, { int: true, min: 1 }),
    repeats: num(a, "repeats", 12, { int: true, min: 1 }),
    slope: num(a, "slope", 1, { min: 0.1 }),
    taskSd: num(a, "task-sd", 0, { min: 0 }),
    bootstrap: num(a, "bootstrap", 100, { int: true, min: 0 }),
    seed: num(a, "seed", 1, { int: true }),
    onProgress: (d, t) => process.stderr.isTTY && process.stderr.write(`\r  ${d}/${t} simulations`),
  });
  if (process.stderr.isTTY) process.stderr.write("\n");
  console.log(`Calibration of ${gate.id} (horizon requirement) on the synthetic calibration suite${num(a, "task-sd", 0) ? `, task sd ${num(a, "task-sd", 0)}` : " (no task-to-task variation: a best case)"}`);
  console.log("true horizon         pass   insufficient   fail");
  for (const r of rows) {
    const pc = (n: number) => `${((100 * n) / r.sims).toFixed(1)}%`.padStart(6);
    console.log(`${`${r.multiple}× (${formatMinutes(r.trueHorizonMinutes)})`.padEnd(18)} ${pc(r.pass)}   ${pc(r.insufficient).padStart(12)}   ${pc(r.fail)}`);
  }
  console.log("PASS at ≤ 1× is the false-pass rate (target ≤ 5% at one-sided 95%). PASS above 1× is power.");
}

async function main() {
  // Piping into `head` closes stdout early; that is not an error.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });
  const a = parse(process.argv.slice(2));
  const cmd = a._[0];
  if (cmd === "run") return runCmd(a, false);
  if (cmd === "demo") return runCmd(a, true);
  if (cmd === "verify") return verifyCmd(a);
  if (cmd === "calibrate") return calibrateCmd(a);
  if (cmd === "self-test") {
    const tasks = await loadSuite(one(a, "suite", "example")!);
    const issues = await selfTest(tasks);
    if (issues.length === 0) {
      console.log(`self-test passed: ${tasks.length} tasks; reference solutions pass, wrong answers fail, every grader file is tamper-detected and answer-key access is caught.`);
      return;
    }
    for (const i of issues) console.log(`✗ ${i.taskId}: ${i.problem}`);
    process.exitCode = 1;
    return;
  }
  if (cmd === "list-tasks") {
    const tasks = await loadSuite(one(a, "suite", "example")!);
    for (const t of tasks) console.log(`${t.id.padEnd(22)} ${formatMinutes(t.humanMinutes).padStart(5)}  ${t.messiness.padEnd(4)} ${t.family.padEnd(18)} ${t.holdout ? "holdout" : ""}`);
    return;
  }
  console.log(HELP);
  if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
