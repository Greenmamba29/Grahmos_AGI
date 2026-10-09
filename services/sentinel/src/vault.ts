import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Episode } from "./types.js";

/**
 * One-way Markdown export of episodes, readable in any Markdown viewer and
 * openable as an Obsidian vault (wiki-links, YAML frontmatter). The JSONL
 * logs and audit chain stay the source of truth; edits made in the vault
 * never flow back.
 */
const safe = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, "_");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
/** YAML scalar: a JSON string is valid YAML and cannot break out of the frontmatter. */
const y = (v: string | number | boolean) => (typeof v === "string" ? JSON.stringify(v) : String(v));
/** Markdown text from logged values: no wiki-links, HTML or line breaks injected. */
const md = (v: unknown) => String(v).replace(/[\r\n]+/g, " ").replace(/[[\]<>`|]/g, (c) => `\\${c}`);

export function exportVault(episodes: Episode[], dir: string): { files: number } {
  mkdirSync(join(dir, "Episodes"), { recursive: true });
  mkdirSync(join(dir, "Models"), { recursive: true });
  const byModel = new Map<string, Episode[]>();
  let files = 0;
  for (const e of episodes) {
    const note = safe(`EP ${e.stream} ${e.onsetSeq}`);
    if (!byModel.has(e.model)) byModel.set(e.model, []);
    byModel.get(e.model)!.push(e);
    const fm = [
      "---",
      `stream: ${y(e.stream)}`,
      `model: ${y(e.model)}`,
      `band: ${y(e.band)}`,
      `state: ${y(e.state)}`,
      `onset: ${y(e.onsetAt)}`,
      `detected: ${y(e.detectedAt)}`,
      ...(e.endAt ? [`end: ${y(e.endAt)}`] : []),
      `baseline_rate: ${y(e.baselineRate)}`,
      `episode_rate: ${y(e.episodeRate)}`,
      ...(e.attach.quantization ? [`quantization: ${y(e.attach.quantization)}`] : []),
      ...(e.attach.checkpoint ? [`checkpoint: ${y(e.attach.checkpoint)}`] : []),
      ...(e.retrospective ? ["retrospective: true"] : []),
      ...(e.splitFrom ? [`split_from: ${y(e.splitFrom)}`] : []),
      "tags: [hallucination-episode]",
      "---",
    ];
    const body = [
      `# Hallucination episode on ${md(e.stream)}`,
      "",
      `Model: [[Models/${safe(e.model)}]]`,
      "",
      `- Began (estimated): ${e.onsetAt} (probe #${e.onsetSeq})`,
      `- Detected: ${e.detectedAt} (probe #${e.detectedSeq})`,
      `- Ended (estimated): ${e.endAt ? `${e.endAt} (probe #${e.endSeq})` : "ongoing"}`,
      `- Rate: ${pct(e.baselineRate)} baseline → ${pct(e.episodeRate)} (${e.hallucinations}/${e.probes} probes)`,
      "",
      "## What changed (co-occurring conditions, not proven causes)",
      "",
      ...(e.attribution.length ? e.attribution.map((a) => `- ${md(a.factor)}: ${md(a.baseline)} → ${md(a.inEpisode)} (effect ${a.effect})`) : ["- Nothing measurable changed in the host signals."]),
      "",
      "## Evidence (first hallucinated probes)",
      "",
      ...e.evidence.map((id) => `- ${md(id)}`),
      "",
    ];
    writeFileSync(join(dir, "Episodes", `${note}.md`), [...fm, ...body].join("\n"));
    files++;
  }
  for (const [model, eps] of byModel) {
    const lines = [`# ${md(model)}`, "", `${eps.length} hallucination episode(s).`, "", ...eps.map((e) => `- [[Episodes/${safe(`EP ${e.stream} ${e.onsetSeq}`)}]] — ${e.band}, ${pct(e.episodeRate)}, ${e.onsetAt}`), ""];
    writeFileSync(join(dir, "Models", `${safe(model)}.md`), lines.join("\n"));
    files++;
  }
  return { files };
}
