import type { Sentinel } from "./sentinel.js";
import type { Episode } from "./types.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const COLORS = ["#2f6fdb", "#d9822b", "#1f9d74", "#b0418f", "#6b5bd6", "#c2412d"];

/** Rolling-rate chart per stream with episodes shaded from estimated onset to estimated end. */
function chart(s: Sentinel, streams: string[], episodes: Episode[]): string {
  const W = 920;
  const H = 300;
  const L = 44;
  const R = 12;
  const T = 14;
  const B = 34;
  const all = streams.flatMap((st) => s.series(st));
  if (!all.length) return "<p>No observations yet.</p>";
  // Loops, not Math.min(...xs): spreading a long series overflows the call stack.
  let minSeq = Infinity;
  let maxSeq = -Infinity;
  let maxRate = 0.2;
  for (const p of all) {
    if (p.seq < minSeq) minSeq = p.seq;
    if (p.seq > maxSeq) maxSeq = p.seq;
    if (p.rate > maxRate) maxRate = p.rate;
  }
  const X = (q: number) => L + ((q - minSeq) / Math.max(1, maxSeq - minSeq)) * (W - L - R);
  const Y = (r: number) => T + (1 - r / maxRate) * (H - T - B);
  const parts = [`<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Rolling hallucination rate by stream">`];
  for (const e of episodes) {
    const x0 = X(e.onsetSeq);
    const x1 = X(e.endSeq ?? maxSeq);
    parts.push(`<rect x="${x0}" y="${T}" width="${Math.max(2, x1 - x0)}" height="${H - T - B}" class="ep"><title>${esc(e.stream)}: ${pct(e.episodeRate)} vs baseline ${pct(e.baselineRate)}</title></rect>`);
  }
  for (let k = 0; k <= 4; k++) {
    const r = (maxRate * k) / 4;
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${Y(r)}" y2="${Y(r)}" class="grid"/><text x="${L - 6}" y="${Y(r) + 4}" text-anchor="end" class="tick">${Math.round(r * 100)}%</text>`);
  }
  parts.push(`<text x="${(W + L) / 2}" y="${H - 6}" text-anchor="middle" class="tick">probe sequence (time →)</text>`);
  streams.forEach((st, i) => {
    const pts = s.series(st).map((p) => `${X(p.seq).toFixed(1)},${Y(p.rate).toFixed(1)}`);
    parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="1.8"/>`);
  });
  parts.push("</svg>");
  return parts.join("");
}

export function renderReport(s: Sentinel, opts: { title?: string; note?: string } = {}): string {
  const st = s.status();
  const eps = s.episodes();
  const streams = st.streams.map((x) => x.stream).filter((x) => !x.endsWith("|all"));
  const legend = streams.map((x, i) => `<span class="key"><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(x)}</span>`).join("");
  const rows = eps
    .map(
      (e) => `<tr><td>${esc(e.stream)}</td><td>${e.state}</td><td>#${e.onsetSeq}<small>${esc(e.onsetAt)}</small></td><td>#${e.detectedSeq}</td><td>${e.endSeq !== undefined ? `#${e.endSeq}<small>${esc(e.endAt ?? "")}</small>` : "ongoing"}</td><td>${pct(e.baselineRate)} → <b>${pct(e.episodeRate)}</b><small>${e.hallucinations}/${e.probes}</small></td><td>${e.attribution
        .slice(0, 3)
        .map((a) => `${esc(a.factor)}: ${esc(String(a.baseline))} → ${esc(String(a.inEpisode))}`)
        .join("<br>")}</td><td>${esc(e.attach.model)}${e.attach.quantization ? ` · ${esc(e.attach.quantization)}` : ""}${e.attach.checkpoint ? ` · ${esc(e.attach.checkpoint)}` : ""}</td></tr>`,
    )
    .join("");
  const streamRows = st.streams
    .map((x) => `<tr><td>${esc(x.stream)}</td><td>${x.state}</td><td>${x.observations}</td><td>${x.baseline === null ? "—" : pct(x.baseline)}</td><td>${pct(x.recentRate)}</td><td>${x.statistic.toFixed(2)} / ${x.threshold}</td></tr>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinel Report</title><style>
:root{--bg:#f7f7f4;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e2dc;--ep:#c2412d}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151514;--fg:#ecebe6;--muted:#9c9b94;--card:#1f1f1d;--line:#34332f;--ep:#ef7a64}}
:root[data-theme="dark"]{--bg:#151514;--fg:#ecebe6;--muted:#9c9b94;--card:#1f1f1d;--line:#34332f;--ep:#ef7a64}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 48px}h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:0 0 8px}
.meta,small,.tick,.legend{color:var(--muted)}small{display:block;font-size:11px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}
.chart{width:100%;height:auto}.grid{stroke:var(--line)}.tick{fill:var(--muted);font-size:11px}.ep{fill:var(--ep);opacity:.14}
.key{margin-right:12px;font-size:12px}.key i{display:inline-block;width:12px;height:3px;margin-right:5px;vertical-align:middle}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:6px;border-top:1px solid var(--line);vertical-align:top}
</style></head><body><main>
<h1>${esc(opts.title ?? "Sentinel — hallucination episodes")}</h1>
<div class="meta">Model ${esc(st.model)} · ${st.probes} probes · ${eps.length} episode(s) · ${st.infraErrors} infra error(s) · audit head <code>${st.auditHead.slice(0, 16)}…</code></div>
${opts.note ? `<p class="meta">${esc(opts.note)}</p>` : ""}
<section class="card"><h2>Rolling hallucination rate (25-probe window)</h2><div class="legend">${legend} <span class="key">shaded = detected episode, estimated onset → estimated end</span></div>${chart(s, streams, eps.filter((e) => !e.stream.endsWith("|all")))}</section>
<section class="card"><h2>Episodes</h2><div class="wrap"><table><thead><tr><th>Stream</th><th>State</th><th>Began (est.)</th><th>Detected</th><th>Ended (est.)</th><th>Rate</th><th>What changed (co-occurring, not proven cause)</th><th>Attached to</th></tr></thead><tbody>${rows || `<tr><td colspan="8">None.</td></tr>`}</tbody></table></div></section>
<section class="card"><h2>Streams</h2><div class="wrap"><table><thead><tr><th>Stream</th><th>State</th><th>Probes</th><th>Baseline</th><th>Last 50</th><th>CUSUM / threshold</th></tr></thead><tbody>${streamRows}</tbody></table></div></section>
</main></body></html>`;
}
