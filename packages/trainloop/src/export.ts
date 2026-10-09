import { SYSTEM_PROMPT, TOOL_SPECS, TRUNCATION_MARK, type RunRecord, type Step, type Task } from "@grahmos/gate";
import { findCanaries, type PoolManager } from "./pools.js";

/**
 * Trajectory exporter: turns GATE runs into supervised fine-tuning data.
 *
 * The filter is the point. A run is exported only if ALL hold:
 *  - its task family is in the TRAIN pool (dev / holdout / canary never leak);
 *  - it passed the clean grade (grader files restored), not just the naive one;
 *  - no critical or warning integrity flag fired (no tampering, answer-key
 *    access, escape attempts, stated intent to game the grader, false claims);
 *  - the agent claimed success and that claim was true;
 *  - the transcript is complete (no truncated tool results — run GATE with
 *    transcriptChars: Infinity);
 *  - no canary string appears anywhere in it.
 * Training only on runs like this is what keeps fine-tuning from teaching
 * the model to cheat.
 *
 * Output is OpenAI chat format with tool calls (one JSON object per line),
 * accepted by most SFT stacks (TRL, Axolotl, LLaMA-Factory, OpenAI fine-tuning).
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface SFTExample {
  messages: ChatMessage[];
  tools: { type: "function"; function: (typeof TOOL_SPECS)[number] }[];
  metadata: { runId: string; taskId: string; family: string; agent: string; humanMinutes: number };
}

export type RejectReason =
  | "not_train_pool"
  | "holdout_task"
  | "unknown_task"
  | "not_clean_pass"
  | "integrity_flag"
  | "no_success_claim"
  | "truncated_transcript"
  | "canary_found"
  | "errored";

export interface ExportResult {
  examples: SFTExample[];
  rejected: { runId: string; reason: RejectReason; detail?: string }[];
  /** Canary strings found anywhere in the input: evidence of leaked held-out or canary material. */
  canaries: { runId: string; canaries: string[] }[];
}

function userPrompt(t: Task): string {
  return `Task: ${t.title}\n\n${t.prompt}\n\nFiles you start with:\n${Object.keys(t.files).sort().map((f) => `- ${f}`).join("\n")}`;
}

function toolArgs(step: Extract<Step, { kind: "tool" }>): Record<string, unknown> {
  const a = step.args;
  switch (step.tool) {
    case "write_file":
      return { path: a.path, content: a.content };
    case "list_files":
      return a.prefix ? { prefix: a.prefix } : {};
    case "run_check":
      return {};
    default:
      return { path: a.path };
  }
}

/** Rebuilds the conversation a model would have had from a recorded trajectory. */
export function toMessages(record: RunRecord, task: Task): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt(task) },
  ];
  let pendingThought: string[] = [];
  let n = 0;
  const call = (name: string, args: Record<string, unknown>, result: string) => {
    const id = `call_${n++}`;
    msgs.push({
      role: "assistant",
      content: pendingThought.length ? pendingThought.join("\n\n") : null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    });
    msgs.push({ role: "tool", tool_call_id: id, content: result });
    pendingThought = [];
  };
  for (const s of record.steps) {
    if (s.kind === "thought") pendingThought.push(s.text);
    else if (s.kind === "tool") call(s.tool, toolArgs(s), s.ok ? s.result : `error: ${s.result}`);
    else call("submit", { claim: s.claim, ...(s.text ? { summary: s.text } : {}) }, "submitted");
  }
  return msgs;
}

function isTruncated(record: RunRecord): boolean {
  return record.steps.some(
    (s) => s.kind === "tool" && (TRUNCATION_MARK.test(s.result) || (typeof s.args.content === "string" && TRUNCATION_MARK.test(s.args.content))),
  );
}

export function exportSFT(records: RunRecord[], tasks: Task[], pools: PoolManager): ExportResult {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: ExportResult = { examples: [], rejected: [], canaries: [] };
  for (const r of records) {
    const found = findCanaries(JSON.stringify(r.steps));
    if (found.length) out.canaries.push({ runId: r.runId, canaries: found });
    const reject = (reason: RejectReason, detail?: string) => out.rejected.push({ runId: r.runId, reason, ...(detail ? { detail } : {}) });
    const task = byId.get(r.taskId);
    if (!task) {
      reject("unknown_task");
      continue;
    }
    // A task the suite marks holdout never trains, whatever the hash split says.
    if (task.holdout || r.holdout) {
      reject("holdout_task");
      continue;
    }
    const pool = pools.poolOfTask(task);
    if (pool !== "train") {
      reject("not_train_pool", pool);
      continue;
    }
    if (r.error) {
      reject("errored", r.error);
      continue;
    }
    if (!r.cleanPass || r.cheated) {
      reject("not_clean_pass");
      continue;
    }
    const flagged = r.flags.filter((f) => f.severity !== "info");
    if (flagged.length) {
      reject("integrity_flag", flagged.map((f) => f.detector).join(","));
      continue;
    }
    if (r.claim !== "success") {
      reject("no_success_claim");
      continue;
    }
    if (isTruncated(r)) {
      reject("truncated_transcript", "run GATE with transcriptChars: Infinity");
      continue;
    }
    if (found.length) {
      reject("canary_found", found.join(","));
      continue;
    }
    out.examples.push({
      messages: toMessages(r, task),
      tools: TOOL_SPECS.map((t) => ({ type: "function" as const, function: t })),
      metadata: { runId: r.runId, taskId: r.taskId, family: r.family, agent: r.agent, humanMinutes: r.humanMinutes },
    });
  }
  return out;
}

// ---------------------------------------------------------------- preference pairs

/**
 * A preference pair (TRL conversational format): the same prompt with a
 * preferred (grounded) and a rejected (hallucinated) answer. Produced from
 * Sentinel probe results whose family is in the train pool.
 */
export interface PreferencePair {
  prompt: ChatMessage[];
  chosen: ChatMessage[];
  rejected: ChatMessage[];
  metadata: { source: string; family: string; probeId: string; model?: string; contextTokens?: number };
}

export interface PairSource {
  probeId: string;
  family: string;
  prompt: ChatMessage[];
  /** What the model said. */
  answer: string;
  /** The grounded reference answer. */
  reference: string;
  hallucinated: boolean;
  model?: string;
  contextTokens?: number;
}

export function exportPreferencePairs(sources: PairSource[], pools: PoolManager): { pairs: PreferencePair[]; skipped: { probeId: string; reason: string }[] } {
  const pairs: PreferencePair[] = [];
  const skipped: { probeId: string; reason: string }[] = [];
  for (const s of sources) {
    if (!s.hallucinated) {
      skipped.push({ probeId: s.probeId, reason: "not a hallucination" });
      continue;
    }
    const pool = pools.poolOf(s.family);
    if (pool !== "train") {
      skipped.push({ probeId: s.probeId, reason: `family in pool "${pool}"` });
      continue;
    }
    const canaries = findCanaries(JSON.stringify(s));
    if (canaries.length) {
      skipped.push({ probeId: s.probeId, reason: `canary found: ${canaries.join(",")}` });
      continue;
    }
    pairs.push({
      prompt: s.prompt,
      chosen: [{ role: "assistant", content: s.reference }],
      rejected: [{ role: "assistant", content: s.answer }],
      metadata: { source: "sentinel", family: s.family, probeId: s.probeId, ...(s.model ? { model: s.model } : {}), ...(s.contextTokens ? { contextTokens: s.contextTokens } : {}) },
    });
  }
  return { pairs, skipped };
}

export const toJSONL = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
