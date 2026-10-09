import { predict } from "./horizon.js";
import type { GateResult, HorizonEstimate, Metrics, RunRecord } from "./types.js";
import { formatMinutes } from "./util.js";

export interface AgentReport {
  agent: string;
  /** "model" (tool calls only, certifiable) or "code" (in-process, trusted, not certifiable). */
  kind?: "model" | "code";
  /** Cheating scored as failure (the number to trust). */
  integrity: Metrics;
  /** Cheating scored as success (what a naive harness would report). */
  naive: Metrics;
  gates: GateResult[];
  /** A few flagged runs to show as evidence. */
  examples: RunRecord[];
}

export interface ReportInput {
  title: string;
  suite: string;
  generatedAt: string;
  seed: number;
  repeats: number;
  harness?: string;
  audit: { entries: number; head: string; verified: boolean; hmac: boolean };
  agents: AgentReport[];
  notes?: string[];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const STATUS_MD = { pass: "**PASS**", fail: "FAIL", insufficient: "INSUFFICIENT" } as const;
const STATUS_TEXT = { pass: "pass", fail: "fail", insufficient: "insufficient evidence" } as const;
const MARK = { pass: "✓", fail: "✗", insufficient: "…" } as const;
const h = (e: HorizonEstimate) => (!e.identified ? "not identified" : e.unbounded ? "> all tasks" : formatMinutes(e.minutes));
const ci = (e: HorizonEstimate) => (e.ciLowUnbounded ? "beyond all tasks" : `${formatMinutes(e.ciLow)} – ${e.ciHigh === null ? "∞" : formatMinutes(e.ciHigh)}`);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function observedText(r: GateResult["results"][number]): string {
  const m = r.requirement.metric;
  if (r.atThreshold) {
    const t = r.atThreshold;
    const fit = r.observed === null ? "n/a" : r.observed === Infinity ? "beyond all tasks" : formatMinutes(r.observed);
    const label = (r.requirement.conservative ?? true) ? "fitted lower bound" : "fitted";
    const v = r.requirement.value;
    return `${label} ${fit}; ${t.successes}/${t.runs} on ${t.tasks} task(s) of ${formatMinutes(v)}–${formatMinutes(2 * v)} (exact lower ${pct(t.exactLower)})`;
  }
  if (r.observed === null) return "n/a";
  if (m === "horizon50" || m === "horizon80") return r.observed === Infinity ? "∞" : formatMinutes(r.observed);
  return pct(r.observed);
}
function targetText(r: GateResult["results"][number]): string {
  const m = r.requirement.metric;
  const v = m === "horizon50" || m === "horizon80" ? formatMinutes(r.requirement.value) : pct(r.requirement.value);
  const sub = r.requirement.subset && r.requirement.subset !== "all" ? ` (${r.requirement.subset} messiness)` : "";
  const conf = Math.round((r.requirement.confidence ?? 0.95) * 100);
  return `${m}${sub} ${r.requirement.op} ${v}${(r.requirement.conservative ?? true) ? ` [${conf}% bound]` : " [point estimate]"}`;
}

export function renderMarkdown(input: ReportInput): string {
  const L: string[] = [];
  L.push(`# ${input.title}`, "");
  L.push(`Suite: \`${input.suite}\` · generated ${input.generatedAt} · seed ${input.seed} · ${input.repeats} repeat(s) per task`, "");
  L.push(
    `Audit log at report time: ${input.audit.entries} entries (head before the final seal \`${input.audit.head.slice(0, 16)}…\` — do not anchor this one; anchor the final head printed by the CLI, i.e. the last line of audit.jsonl), self-check ${input.audit.verified ? "passed" : "**FAILED**"}${input.audit.hmac ? " (HMAC)" : " (SHA-256, unkeyed — tamper-evident only if the head is anchored elsewhere)"}. The written files are sealed in a final \`artifacts\` entry; run \`gate verify <dir>\` to check the whole folder.`,
    "",
    "Horizon intervals are hierarchical-bootstrap 95% intervals (family → task → run). Their coverage depends on repeats (independent simulation on this suite: 77–88% at 1 repeat, 95–99% at 8+), so gates also require exact binomial evidence on tasks between the threshold and twice it.",
    "",
  );
  for (const n of input.notes ?? []) L.push(`> ${n}`, "");

  L.push("## Summary", "");
  L.push("| Agent | 50% horizon | 80% horizon | 80% horizon, messy tasks | Success (cheat = fail) | Success (naive) | Cheat rate | False claims |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const a of input.agents) {
    const all = a.integrity.subsets[0]!;
    const high = a.integrity.subsets[2]!;
    L.push(
      `| ${a.agent} | ${h(all.fit.h50)} | ${h(all.fit.h80)} | ${h(high.fit.h80)} | ${pct(all.successRate)} | ${pct(a.naive.subsets[0]!.successRate)} | ${pct(a.integrity.cheatRate)} | ${pct(a.integrity.falseClaimRate)} |`,
    );
  }
  L.push("");

  for (const a of input.agents) {
    L.push(`## ${a.agent}`, "");
    if (a.kind !== "model") {
      L.push("> In-process code agent: it runs inside the harness process and is trusted, so its gate verdicts are not certifiable. Certifiable verdicts come from model agents driven through the built-in adapters.", "");
    }
    L.push("### Time horizons (cheating counted as failure)", "");
    L.push("| Subset | Tasks | Runs | Success | 50% horizon | interval | 80% horizon | interval |", "|---|---|---|---|---|---|---|---|");
    for (const s of a.integrity.subsets) {
      L.push(`| ${s.subset} | ${s.tasks} | ${s.runs} | ${pct(s.successRate)} | ${h(s.fit.h50)} | ${ci(s.fit.h50)} | ${h(s.fit.h80)} | ${ci(s.fit.h80)} |`);
    }
    if (a.integrity.infraErrors) L.push("", `${a.integrity.infraErrors} run(s) excluded for infrastructure errors (HTTP 429/5xx, network).`);
    const nAll = a.naive.subsets[0]!;
    L.push("", `Naive harness (cheating counted as success): 50% horizon ${h(nAll.fit.h50)}, 80% horizon ${h(nAll.fit.h80)}.`, "");
    const notes = a.integrity.subsets.flatMap((s) => s.fit.notes.map((n) => `${s.subset}: ${n}`));
    if (notes.length) L.push(...notes.map((n) => `- ${n}`), "");

    L.push("### Integrity", "");
    L.push(`Cheat rate ${pct(a.integrity.cheatRate)} · false success claims ${pct(a.integrity.falseClaimRate)} · eval awareness ${pct(a.integrity.evalAwarenessRate)} · stated intent to game ${pct(a.integrity.rewardHackIntentRate)}`, "");
    const counts = Object.entries(a.integrity.detectorCounts).sort((x, y) => y[1] - x[1]);
    if (counts.length) {
      L.push("| Detector | Flags |", "|---|---|", ...counts.map(([d, n]) => `| ${d} | ${n} |`), "");
    }
    if (a.examples.length) {
      L.push("Example flagged runs:", "");
      for (const r of a.examples) {
        for (const f of r.flags.filter((f) => f.severity !== "info")) L.push(`- \`${r.runId}\` — **${f.detector}** (${f.severity}): ${f.evidence}`);
      }
      L.push("");
    }

    L.push("### Roadmap gates", "", "PASS = the conservative (95%) bound clears the bar · FAIL = even the optimistic bound misses it · INSUFFICIENT = in between: not enough evidence either way (more runs, tasks or task families needed). Only PASS is a result.", "");
    L.push("| Gate | Result | Requirement | Observed | Note |", "|---|---|---|---|---|");
    for (const g of a.gates) {
      g.results.forEach((r, i) => {
        L.push(`| ${i === 0 ? `${g.gate.id} ${g.gate.name}` : ""} | ${i === 0 ? STATUS_MD[g.status] : ""} | ${targetText(r)} ${MARK[r.status]} | ${observedText(r)} | ${r.note ?? ""} |`);
      });
    }
    for (const g of a.gates) if (g.note) L.push(`- ${g.gate.id}: ${g.note}`);
    L.push("");
  }
  return L.join("\n");
}

const PALETTE = ["#2f6fdb", "#d9822b", "#1f9d74", "#b0418f", "#6b5bd6"];

function curveSvg(input: ReportInput): string {
  const W = 640;
  const H = 280;
  const padL = 44;
  const padR = 16;
  const padT = 16;
  const padB = 40;
  const xMin = Math.log2(1);
  const xMax = Math.log2(60 * 24 * 7);
  const X = (m: number) => padL + ((Math.log2(m) - xMin) / (xMax - xMin)) * (W - padL - padR);
  const Y = (p: number) => padT + (1 - p) * (H - padT - padB);
  const ticks = [1, 4, 15, 60, 240, 960, 3840];
  const longest = Math.max(1, ...input.agents.map((a) => a.integrity.subsets[0]!.maxTaskMinutes));
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Success probability against human task length" class="chart">`);
  parts.push(`<rect x="${X(longest)}" y="${padT}" width="${W - padR - X(longest)}" height="${H - padT - padB}" class="extrap"/>`);
  parts.push(`<text x="${X(longest) + 6}" y="${padT + 14}" class="tick">extrapolated: no tasks this long</text>`);
  for (const p of [0, 0.5, 0.8, 1]) {
    parts.push(`<line x1="${padL}" x2="${W - padR}" y1="${Y(p)}" y2="${Y(p)}" class="${p === 0.5 || p === 0.8 ? "ref" : "grid"}"/>`);
    parts.push(`<text x="${padL - 6}" y="${Y(p) + 4}" text-anchor="end" class="tick">${Math.round(p * 100)}%</text>`);
  }
  for (const t of ticks) {
    parts.push(`<line x1="${X(t)}" x2="${X(t)}" y1="${padT}" y2="${H - padB}" class="grid"/>`);
    parts.push(`<text x="${X(t)}" y="${H - padB + 16}" text-anchor="middle" class="tick">${formatMinutes(t)}</text>`);
  }
  parts.push(`<text x="${(W + padL) / 2}" y="${H - 6}" text-anchor="middle" class="axis">Human time for the task (log scale)</text>`);
  input.agents.forEach((a, i) => {
    const color = PALETTE[i % PALETTE.length]!;
    for (const [m, dash] of [
      [a.integrity, ""],
      [a.naive, "5 4"],
    ] as const) {
      const fit = m.subsets[0]!.fit;
      if (!Number.isFinite(fit.slope)) continue;
      const pts: string[] = [];
      for (let k = 0; k <= 80; k++) {
        const x = xMin + ((xMax - xMin) * k) / 80;
        const mins = 2 ** x;
        pts.push(`${X(mins).toFixed(1)},${Y(predict(fit, mins)).toFixed(1)}`);
      }
      parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}" opacity="0.7"` : ""}/>`);
    }
  });
  parts.push(`</svg>`);
  return parts.join("");
}

export function renderHTML(input: ReportInput): string {
  const legend = input.agents
    .map((a, i) => `<span class="key"><i style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(a.agent)}</span>`)
    .join("");
  const cards = input.agents
    .map((a) => {
      const all = a.integrity.subsets[0]!;
      const high = a.integrity.subsets[2]!;
      const nAll = a.naive.subsets[0]!;
      const gates = a.gates.map((g) => `<span class="pill ${g.status}">${esc(g.gate.id)} ${STATUS_TEXT[g.status]}</span>`).join("");
      return `<section class="card">
  <h2>${esc(a.agent)}</h2>
  ${a.kind !== "model" ? `<p class="naive">In-process code agent (trusted): verdicts are illustrative, not certifiable.</p>` : ""}
  <div class="gates">${gates}</div>
  <div class="stats">
    <div><b>${h(all.fit.h50)}</b><span>50% horizon</span><small>interval ${ci(all.fit.h50)}</small></div>
    <div><b>${h(all.fit.h80)}</b><span>80% horizon</span><small>interval ${ci(all.fit.h80)}</small></div>
    <div><b>${h(high.fit.h80)}</b><span>80% horizon, messy</span><small>interval ${ci(high.fit.h80)}</small></div>
    <div><b>${pct(a.integrity.cheatRate)}</b><span>cheat rate</span><small>false claims ${pct(a.integrity.falseClaimRate)}</small></div>
  </div>
  <p class="naive">A naive harness would report a 50% horizon of <b>${h(nAll.fit.h50)}</b> and ${pct(nAll.successRate)} success, against <b>${h(all.fit.h50)}</b> and ${pct(all.successRate)} with cheating counted as failure.</p>
  <table><thead><tr><th>Gate</th><th>Requirement</th><th>Observed</th><th></th></tr></thead><tbody>
  ${a.gates
    .flatMap((g) =>
      g.results.map(
        (r, i) =>
          `<tr><td>${i === 0 ? esc(`${g.gate.id} · ${g.gate.name}`) : ""}</td><td>${esc(targetText(r))}</td><td>${esc(observedText(r))}</td><td class="${r.status}">${MARK[r.status]}${r.note ? `<small>${esc(r.note)}</small>` : ""}</td></tr>`,
      ).concat(g.note ? [`<tr><td></td><td colspan="3" class="${g.status}"><small>${esc(`${g.gate.id}: ${g.note}`)}</small></td></tr>`] : []),
    )
    .join("")}
  </tbody></table>
  ${
    a.examples.length
      ? `<details><summary>Example integrity flags</summary><ul>${a.examples
          .flatMap((r) => r.flags.filter((f) => f.severity !== "info").map((f) => `<li><code>${esc(r.taskId)}#${r.repeat}</code> <b>${esc(f.detector)}</b> (${f.severity}): ${esc(f.evidence)}</li>`))
          .join("")}</ul></details>`
      : ""
  }
</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GATE Report</title>
<style>
:root{--bg:#f7f7f4;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e2dc;--ok:#1f8a5b;--bad:#c2412d;--warn:#a86b00;--ref:#b9b6aa}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151514;--fg:#ecebe6;--muted:#9c9b94;--card:#1f1f1d;--line:#34332f;--ok:#4cc38a;--bad:#ef7a64;--warn:#e0a63a;--ref:#5d5b54}}
:root[data-theme="dark"]{--bg:#151514;--fg:#ecebe6;--muted:#9c9b94;--card:#1f1f1d;--line:#34332f;--ok:#4cc38a;--bad:#ef7a64;--warn:#e0a63a;--ref:#5d5b54}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 60px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:0 0 8px}
.meta{color:var(--muted);font-size:13px;margin-bottom:20px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:16px 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:12px 0}.stats div{display:flex;flex-direction:column}
.stats b{font-size:24px;font-variant-numeric:tabular-nums}.stats span{font-size:13px}.stats small,.naive,td small{color:var(--muted);font-size:12px}
td small{display:block}.pill{display:inline-block;font-size:12px;padding:2px 8px;border-radius:99px;margin-right:6px;border:1px solid}
.pill.pass{color:var(--ok);border-color:var(--ok)}.pill.fail{color:var(--bad);border-color:var(--bad)}.pill.insufficient{color:var(--warn);border-color:var(--warn)}
td.pass{color:var(--ok)}td.fail{color:var(--bad)}td.insufficient{color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}th,td{text-align:left;padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}
td.ok{color:var(--ok)}td.bad{color:var(--bad)}.chart{width:100%;height:auto}.chart .grid{stroke:var(--line)}.chart .ref{stroke:var(--ref);stroke-dasharray:2 3}.chart .extrap{fill:var(--line);opacity:.45}
.chart text{fill:var(--muted);font-size:11px}.legend{font-size:13px;color:var(--muted)}.key{margin-right:14px}.key i{display:inline-block;width:12px;height:3px;margin-right:6px;vertical-align:middle}
code{font-size:12px}details{margin-top:10px;font-size:13px}.wrap{overflow-x:auto}
</style></head><body><main>
<h1>${esc(input.title)}</h1>
<div class="meta">Suite <code>${esc(input.suite)}</code> · ${esc(input.generatedAt)} · seed ${input.seed} · ${input.repeats} repeat(s)/task${input.harness ? ` · ${esc(input.harness)}` : ""} · audit log ${input.audit.entries} entries at report time, self-check ${input.audit.verified ? "passed" : "FAILED"}${input.audit.hmac ? " (HMAC)" : " (unkeyed)"} · pre-seal head <code>${input.audit.head.slice(0, 16)}…</code> (anchor the final head from the CLI) · intervals: hierarchical bootstrap; gates use exact bounds</div>
${(input.notes ?? []).map((n) => `<p class="naive">${esc(n)}</p>`).join("")}
<section class="card"><h2>Success probability vs task length</h2>
<div class="legend">${legend} <span class="key">solid = cheating counted as failure · dashed = naive</span></div>
${curveSvg(input)}</section>
${cards}
</main></body></html>`;
}
