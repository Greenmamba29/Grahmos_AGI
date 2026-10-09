#!/usr/bin/env node
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportPreferencePairs, PoolManager, toJSONL } from "@grahmos/trainloop";
import { OpenAICompatibleModel, SimulatedModel, type ModelClient } from "../src/model.js";
import { renderReport } from "../src/report.js";
import { hostAt, SCENARIO, SCENARIO_LENGTH, scenarioRate } from "../src/scenario.js";
import { JsonlSink, PushedHostContext, Sentinel, SENTINEL_POOL_RATIOS, WebhookSink } from "../src/sentinel.js";
import { serveSentinel } from "../src/server.js";
import { exportVault } from "../src/vault.js";
import { benchDetection } from "../src/bench.js";

const HELP = `sentinel — continuous hallucination monitor for AGSI Core

  sentinel run     [--data data/sentinel] [--port 7710] [--interval 30000] [--max-context 32768] [--max-tokens 64]
                   [--no-thinking] [--webhook URL]
  sentinel demo    [--out runs/sentinel-demo]   simulated model with known episodes; checks detection against truth
  sentinel bench   [--seeds 10]                 detection accuracy vs ground truth (misses, delay, onset/end error)
  sentinel report  --data DIR [--out report.html]
  sentinel vault   --data DIR --out DIR          one-way Markdown/Obsidian export of episodes
  sentinel pairs   --data DIR --out pairs.jsonl  preference pairs from train-pool hallucinations

Env (run):
  SENTINEL_MODEL        model id served by the local endpoint (required)
  SENTINEL_BASE_URL     OpenAI-compatible base URL (default http://127.0.0.1:8000/v1, vLLM's default)
  SENTINEL_API_KEY      optional bearer token for the model endpoint
  SENTINEL_TOKEN        optional bearer token required on Sentinel's own API
  SENTINEL_AUDIT_KEY    HMAC key for the audit chain (recommended)
  SENTINEL_POOL_SALT    pool salt (≥16 chars); enables train/monitor probe split and preference-pair export
`;

function args(argv: string[]) {
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const n = argv[i + 1];
      flags[a.slice(2)] = n !== undefined && !n.startsWith("--") ? (i++, n) : "true";
    } else pos.push(a);
  }
  return { flags, pos };
}

function pools(): PoolManager | undefined {
  const salt = process.env.SENTINEL_POOL_SALT;
  return salt ? new PoolManager({ salt, ratios: SENTINEL_POOL_RATIOS }) : undefined;
}

/** Opens an existing data dir read-only-ish (no probing) for exports. */
function open(dataDir: string): Sentinel {
  const idle: ModelClient = { name: "offline", complete: async () => ({ text: "", latencyMs: 0 }) };
  return new Sentinel({ model: idle, host: new PushedHostContext({ modelId: "offline" }), dataDir, pools: pools(), auditKey: process.env.SENTINEL_AUDIT_KEY });
}

async function demo(out: string) {
  rmSync(out, { recursive: true, force: true });
  let i = 0;
  const host = new PushedHostContext(hostAt(0));
  const model = new SimulatedModel("qwen3.6-27b", scenarioRate(() => i), 11);
  const t0 = Date.parse("2026-10-09T00:00:00Z");
  const s = new Sentinel({
    model,
    host,
    dataDir: join(out, "data"),
    pools: new PoolManager({ salt: "demo-salt-not-secret-0001", ratios: SENTINEL_POOL_RATIOS }),
    seed: 3,
    now: () => new Date(t0 + i * 30_000),
    sinks: [new JsonlSink(join(out, "events.jsonl"))],
  });
  for (i = 0; i < SCENARIO_LENGTH; i++) {
    host.push(hostAt(i));
    await s.probeOnce();
  }
  const eps = s.episodes();
  console.log(`Simulated ${SCENARIO_LENGTH} probes (one every 30 s of simulated time = ${((SCENARIO_LENGTH * 30) / 3600).toFixed(1)} h).\n`);
  console.log("Ground truth:");
  for (const r of SCENARIO) console.log(`  ${r.name}: probes ${r.from}–${r.to}${r.bands ? ` (bands ${r.bands.join(",")})` : " (all bands)"}`);
  console.log("\nDetected episodes (onset/end are estimates; 'detected' is when the alarm fired):");
  for (const e of eps) {
    const top = e.attribution.slice(0, 2).map((a) => `${a.factor} ${a.baseline}→${a.inEpisode}`).join(", ");
    console.log(
      `  ${e.stream.padEnd(20)} began #${String(e.onsetSeq).padStart(4)}  detected #${String(e.detectedSeq).padStart(4)}  ended #${String(e.endSeq ?? "—").padStart(4)}  ${(e.baselineRate * 100).toFixed(1)}% → ${(e.episodeRate * 100).toFixed(1)}%  [${top}]`,
    );
  }
  writeFileSync(join(out, "report.html"), renderReport(s, { title: "Sentinel demo — simulated model, known episodes", note: "Simulated model with hallucination episodes injected at known times; shows what Sentinel reports, not a measurement of any real model." }));
  const { files } = exportVault(eps, join(out, "vault"));
  const { pairs } = exportPreferencePairs(s.pairSources(), new PoolManager({ salt: "demo-salt-not-secret-0001", ratios: SENTINEL_POOL_RATIOS }));
  writeFileSync(join(out, "preference-pairs.jsonl"), toJSONL(pairs));
  console.log(`\nWrote ${out}/report.html, ${files} vault notes, ${pairs.length} preference pairs (train-pool probes only), audit head ${s.auditHead.slice(0, 16)}…`);
}

async function main() {
  const { flags, pos } = args(process.argv.slice(2));
  const cmd = pos[0];
  if (cmd === "demo") return demo(flags.out ?? "runs/sentinel-demo");
  if (cmd === "bench") {
    const r = await benchDetection({ seeds: Number(flags.seeds ?? 10) });
    console.log(`Scenario ${r.seeds} seeds × true episode windows = ${r.windows}`);
    console.log(`  detected ${r.windows - r.misses}/${r.windows} (misses by stream: ${JSON.stringify(r.missesByStream)})`);
    console.log(`  extra fragments ${r.fragments}, false alarms ${r.falseAlarms}`);
    console.log(`  onset error (probes) median ${r.onsetError.median}, MAE ${r.onsetError.mae}; end error median ${r.endError.median}, MAE ${r.endError.mae}`);
    console.log(`  alarm delay after true onset (probes, all bands interleaved) median ${r.delay.median}, p90 ${r.delay.p90}`);
    console.log("\n  per stream (true window → detected; errors in probes, median):");
    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : "—");
    for (const st of [...new Set(r.details.map((d) => `${d.stream} ${d.from}-${d.to}`))]) {
      const ds = r.details.filter((d) => `${d.stream} ${d.from}-${d.to}` === st);
      const hit = ds.filter((d) => d.onset !== undefined);
      console.log(
        `    ${st.padEnd(22)} ${hit.length}/${ds.length}  onset ${med(hit.map((d) => d.onset! - d.from))}  alarm +${med(hit.map((d) => d.detected! - d.from))}  end ${med(hit.map((d) => (d.end ?? 2000) - d.to))}`,
      );
    }
    return;
  }
  if (cmd === "report") {
    writeFileSync(flags.out ?? "report.html", renderReport(open(need(flags.data, "--data"))));
    return;
  }
  if (cmd === "vault") {
    const r = exportVault(open(need(flags.data, "--data")).episodes(), need(flags.out, "--out"));
    console.log(`wrote ${r.files} notes`);
    return;
  }
  if (cmd === "pairs") {
    const p = pools();
    if (!p) throw new Error("SENTINEL_POOL_SALT is required: without a pool split there are no train-pool probes");
    const { pairs, skipped } = exportPreferencePairs(open(need(flags.data, "--data")).pairSources(), p);
    writeFileSync(need(flags.out, "--out"), toJSONL(pairs));
    console.log(`wrote ${pairs.length} pairs (${skipped.length} skipped)`);
    return;
  }
  if (cmd === "run") {
    const modelId = need(process.env.SENTINEL_MODEL, "SENTINEL_MODEL");
    const host = new PushedHostContext({ modelId });
    const dataDir = flags.data ?? "data/sentinel";
    const s = new Sentinel({
      model: new OpenAICompatibleModel({
        model: modelId,
        baseUrl: process.env.SENTINEL_BASE_URL ?? "http://127.0.0.1:8000/v1",
        apiKey: process.env.SENTINEL_API_KEY,
        maxTokens: flags["max-tokens"] ? Number(flags["max-tokens"]) : undefined,
        disableThinking: flags["no-thinking"] === "true",
      }),
      host,
      dataDir,
      pools: pools(),
      maxContextTokens: flags["max-context"] ? Number(flags["max-context"]) : undefined,
      auditKey: process.env.SENTINEL_AUDIT_KEY,
      sinks: [new JsonlSink(join(dataDir, "events.jsonl")), ...(flags.webhook ? [new WebhookSink(flags.webhook)] : [])],
    });
    const port = Number(flags.port ?? 7710);
    serveSentinel(s, host, { token: process.env.SENTINEL_TOKEN }).listen(port, "127.0.0.1", () => console.log(`sentinel API on http://127.0.0.1:${port} (status, episodes, series, report)`));
    const st = s.status();
    console.log(`probing ${modelId} at bands ${st.bands.join(", ")}; resumed ${st.probes} logged probes${s.replayRejected ? ` (${s.replayRejected} rejected: no matching audit entry)` : ""}`);
    const ctl = new AbortController();
    process.on("SIGINT", () => ctl.abort());
    process.on("SIGTERM", () => ctl.abort());
    await s.run({ intervalMs: Number(flags.interval ?? 30_000), signal: ctl.signal });
    process.exit(0);
  }
  console.log(HELP);
  if (cmd && cmd !== "help") process.exitCode = 1;
}

function need<T>(v: T | undefined, name: string): T {
  if (v === undefined || v === "") throw new Error(`${name} is required`);
  return v;
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
