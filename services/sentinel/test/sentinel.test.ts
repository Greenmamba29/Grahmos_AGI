import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InfraError, verifyAuditLog } from "@grahmos/gate";
import { exportPreferencePairs, makeCanary } from "@grahmos/trainloop";
import { generateProbe } from "../src/probes.js";
import { JsonlSink, PushedHostContext, repairTail, Sentinel, SENTINEL_POOL_RATIOS, WebhookSink, type HostContextSource } from "../src/sentinel.js";
import { SimulatedModel, type ModelClient } from "../src/model.js";
import type { ProbeResult, SentinelEvent } from "../src/types.js";
import { BANDS, drive, EPISODE, fixedModel, makeHarness, pools, SALT, tempDir } from "./helpers.js";

const AUDIT_KEY = "audit-key-for-tests";

describe("Sentinel.probeOnce", () => {
  it("records a scored result, persists it and chains it into the audit log", async () => {
    const dir = tempDir();
    const h = makeHarness(dir);
    const r = (await h.sentinel.probeOnce())!;
    const p = generateProbe(2, 0, { bands: BANDS });
    expect(r).toMatchObject({ probeId: p.id, family: p.family, template: p.template, kind: p.kind, band: p.band, contextTokens: p.contextTokens, reference: p.reference, seq: 0, probeSeq: 0, seed: 2, bands: BANDS, stream: "m|400" });
    expect(["correct", "hallucinated", "abstained"]).toContain(r.outcome);
    expect(r.hallucinated).toBe(r.outcome === "hallucinated");
    expect(r.at).toBe("2026-10-09T00:00:00.000Z");
    expect(r.host.modelId).toBe("m");
    const lines = readFileSync(join(dir, "probes.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(r);
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8");
    const v = verifyAuditLog(audit, AUDIT_KEY);
    expect(v).toMatchObject({ ok: true, count: 1, lastType: "probe" });
    expect(h.sentinel.auditHead).toBe(v.head);
    const st = h.sentinel.status();
    expect(st.probes).toBe(1);
    expect(st.auditEntries).toBe(1);
    expect(st.bands).toEqual(["400", "800"]);
    expect(Object.values(st.outcomes).reduce((a, b) => a + b, 0)).toBe(1);
    expect(h.sentinel.modelName).toBe("m");
  });

  it("labels bands below 1000 tokens without a k suffix and above with one", async () => {
    const h = makeHarness(tempDir(), { bands: [400, 2000] });
    const seen = new Set<string>();
    for (let k = 0; k < 30; k++) seen.add((await h.sentinel.probeOnce())!.stream);
    expect([...seen].sort()).toEqual(["m|2k", "m|400"]);
  });

  it("skips bands above maxContextTokens and refuses when none fit", async () => {
    const h = makeHarness(tempDir(), { bands: [400, 800, 5000], maxContextTokens: 1000 });
    for (let k = 0; k < 40; k++) expect((await h.sentinel.probeOnce())!.band).toBeLessThanOrEqual(1000);
    expect(() => makeHarness(tempDir(), { bands: [5000], maxContextTokens: 1000 })).toThrow(/no probe bands fit/);
  });

  it("assigns train vs monitor roles from the pool split", async () => {
    const h = makeHarness(tempDir());
    await drive(h, 120);
    const pm = pools();
    const results = h.sentinel.allResults;
    for (const r of results) {
      const pool = pm.poolOf(r.family);
      expect(r.pool).toBe(pool);
      expect(r.role).toBe(pool === "train" ? "train" : "monitor");
    }
    const train = results.filter((r) => r.role === "train").length;
    expect(train).toBeGreaterThan(0);
    expect(train).toBeLessThan(results.length);
  });

  it("without pools every probe is a monitor probe", async () => {
    const h = makeHarness(tempDir(), { pools: undefined });
    await drive(h, 20);
    expect(h.sentinel.allResults.every((r) => r.role === "monitor" && r.pool === "monitor")).toBe(true);
  });

  it("train-pool probes never feed the detection streams", async () => {
    const h = makeHarness(tempDir());
    await drive(h, 200);
    const monitor = h.sentinel.allResults.filter((r) => r.role === "monitor");
    const bandObs = [...h.sentinel.monitors.values()].filter((m) => !m.stream.endsWith("|all")).reduce((s, m) => s + m.count, 0);
    expect(bandObs).toBe(monitor.length);
    expect(h.sentinel.monitors.get("m|all")!.count).toBe(monitor.length);
    const monitored = new Set([...h.sentinel.monitors.values()].flatMap((m) => m.observations.map((o) => o.probeId)));
    for (const r of h.sentinel.allResults.filter((x) => x.role === "train")) expect(monitored.has(r.probeId)).toBe(false);
  });

  it("counts and skips infrastructure errors; other errors propagate", async () => {
    let n = 0;
    const flaky: ModelClient = {
      name: "m",
      async complete() {
        n++;
        if (n % 3 === 0) throw new InfraError("HTTP 503");
        return { text: "NOT IN DOCUMENT", latencyMs: 1 };
      },
    };
    const h = makeHarness(tempDir(), { model: flaky });
    const out: (ProbeResult | null)[] = [];
    for (let k = 0; k < 9; k++) out.push(await h.sentinel.probeOnce());
    expect(out.filter((x) => x === null)).toHaveLength(3);
    expect(h.sentinel.infraErrors).toBe(3);
    expect(h.sentinel.allResults).toHaveLength(6);
    // The failed probe's sequence number is skipped, not reused.
    expect(out[3]!.seq).toBe(3);
    expect(h.sentinel.status().infraErrors).toBe(3);

    const broken: ModelClient = { name: "m", complete: async () => Promise.reject(new TypeError("bug")) };
    await expect(makeHarness(tempDir(), { model: broken }).sentinel.probeOnce()).rejects.toThrow(TypeError);
  });
});

describe("Sentinel episodes, replay and audit", () => {
  it("detects the planted episode on the |all stream with onset/end near truth", async () => {
    const dir = tempDir();
    const events: SentinelEvent[] = [];
    const h = makeHarness(dir, { sinks: [{ emit: (e) => void events.push(e) }] });
    await drive(h, 450);
    const all = h.sentinel.episodes().filter((e) => e.stream === "m|all");
    expect(all.length).toBeGreaterThanOrEqual(1);
    const main = all.find((e) => e.onsetSeq < EPISODE.to && (e.endSeq ?? 1e9) > EPISODE.from)!;
    expect(main).toBeDefined();
    expect(Math.abs(main.onsetSeq - EPISODE.from)).toBeLessThanOrEqual(30);
    expect(main.state).toBe("closed");
    expect(Math.abs(main.endSeq! - EPISODE.to)).toBeLessThanOrEqual(40);
    expect(main.attribution[0]!.factor).toBe("thermalDerate");
    expect(main.attach).toEqual({ model: "m", checkpoint: "ckpt-1", quantization: "q8_0" });
    // Every episode transition was emitted, logged and audited.
    const transitions = events.filter((e) => e.type === "episode.opened" || e.type === "episode.closed");
    expect(transitions.length).toBeGreaterThanOrEqual(2);
    expect(events.filter((e) => e.type === "probe.result")).toHaveLength(450);
    const logged = readFileSync(join(dir, "episodes.jsonl"), "utf8").trim().split("\n");
    expect(logged).toHaveLength(transitions.length);
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8");
    const v = verifyAuditLog(audit, AUDIT_KEY);
    expect(v.ok).toBe(true);
    expect(v.count).toBe(450 + transitions.length);
    // status() reflects the streams.
    const st = h.sentinel.status();
    expect(st.streams.map((s) => s.stream)).toEqual(["m|400", "m|800", "m|all"]);
    expect(st.streams.every((s) => s.state === "normal" || s.state === "episode")).toBe(true);
    expect(st.auditHead).toBe(v.head);
  });

  it("rebuilds identical state from probes.jsonl after a restart and resumes the audit chain", async () => {
    const dir = tempDir();
    const a = makeHarness(dir);
    await drive(a, 450);
    const before = { episodes: a.sentinel.episodes(), status: a.sentinel.status(), pairs: a.sentinel.pairSources(), series: a.sentinel.series("m|all") };
    const episodesLog = readFileSync(join(dir, "episodes.jsonl"), "utf8");

    const b = makeHarness(dir);
    expect(b.sentinel.episodes()).toEqual(before.episodes);
    expect(b.sentinel.status()).toEqual(before.status);
    expect(b.sentinel.pairSources()).toEqual(before.pairs);
    expect(b.sentinel.series("m|all")).toEqual(before.series);
    // Replay does not re-log episodes.
    expect(readFileSync(join(dir, "episodes.jsonl"), "utf8")).toBe(episodesLog);

    // Probing continues the sequence and the chain.
    b.tick.i = 450;
    await drive(b, 5);
    expect(b.sentinel.allResults.at(-1)!.probeId).toBe("p2-454");
    const v = verifyAuditLog(readFileSync(join(dir, "audit.jsonl"), "utf8"), AUDIT_KEY);
    expect(v.ok).toBe(true);
    expect(v.count).toBeGreaterThanOrEqual(455);
    expect(b.sentinel.auditHead).toBe(v.head);
  });

  it("refuses to resume a tampered audit chain or the wrong key", async () => {
    const dir = tempDir();
    await drive(makeHarness(dir), 5);
    expect(() => makeHarness(dir, { auditKey: "a different key" })).toThrow(/cannot resume/);
    const path = join(dir, "audit.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const e = JSON.parse(lines[2]!) as { payload: { outcome: string } };
    e.payload.outcome = e.payload.outcome === "correct" ? "hallucinated" : "correct";
    lines[2] = JSON.stringify(e);
    writeFileSync(path, `${lines.join("\n")}\n`);
    expect(() => makeHarness(dir)).toThrow(/cannot resume/);
  });

  it("pairSources returns train-pool hallucinations that export as preference pairs", async () => {
    const dir = tempDir();
    const h = makeHarness(dir);
    await drive(h, 450);
    const sources = h.sentinel.pairSources();
    expect(sources.length).toBeGreaterThan(0);
    const pm = pools();
    for (const s of sources) {
      expect(pm.poolOf(s.family)).toBe("train");
      expect(s.hallucinated).toBe(true);
      const seq = Number(s.probeId.split("-").pop());
      const p = generateProbe(2, seq, { bands: BANDS });
      expect(s.prompt).toEqual(p.messages);
      expect(s.reference).toBe(p.reference);
      expect(s.answer).not.toBe(p.reference);
      expect(s.model).toBe("m");
    }
    const { pairs, skipped } = exportPreferencePairs(sources, pm);
    expect(skipped).toEqual([]);
    expect(pairs).toHaveLength(sources.length);
    expect(pairs[0]!.chosen).toEqual([{ role: "assistant", content: sources[0]!.reference }]);
    expect(pairs[0]!.rejected).toEqual([{ role: "assistant", content: sources[0]!.answer }]);
    // Monitor-pool hallucinations never become pairs.
    const trainIds = new Set(sources.map((s) => s.probeId));
    for (const r of h.sentinel.allResults.filter((x) => x.role === "monitor" && x.hallucinated)) expect(trainIds.has(r.probeId)).toBe(false);
  });

  // Regression: pairSources() used to regenerate prompts with the CURRENT seed/bands.
  it("pairSources after a restart with a different seed and bands still matches the recorded probes", async () => {
    const dir = tempDir();
    const h = makeHarness(dir, { seed: 3 });
    await drive(h, 300);
    const recorded = new Map(h.sentinel.allResults.map((r) => [r.probeId, r]));
    const before = h.sentinel.pairSources();
    const reopened = makeHarness(dir, { seed: undefined, bands: [1000] });
    const sources = reopened.sentinel.pairSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources).toEqual(before);
    for (const s of sources) {
      const r = recorded.get(s.probeId)!;
      expect(r.seed).toBe(3);
      expect(s.reference).toBe(r.reference);
      expect(Math.ceil(s.prompt.map((m) => m.content ?? "").join("").length / 3)).toBeCloseTo(r.contextTokens, -1);
    }
  });

  it("emits a contamination event when the model outputs a canary", async () => {
    const canary = makeCanary("holdout", SALT);
    const events: SentinelEvent[] = [];
    const h = makeHarness(tempDir(), { model: fixedModel(`The answer is ${canary}`), sinks: [{ emit: (e) => void events.push(e) }] });
    const r = (await h.sentinel.probeOnce())!;
    expect(events.map((e) => e.type)).toEqual(["probe.result", "contamination"]);
    expect(events[1]).toEqual({ type: "contamination", probeId: r.probeId, canaries: [canary] });
  });

  it("swallows sink errors (sync and async) and keeps delivering to other sinks", async () => {
    const got: SentinelEvent[] = [];
    const h = makeHarness(tempDir(), {
      sinks: [
        {
          emit: () => {
            throw new Error("sync sink down");
          },
        },
        { emit: async () => Promise.reject(new Error("async sink down")) },
        { emit: (e) => void got.push(e) },
      ],
    });
    await expect(h.sentinel.probeOnce()).resolves.not.toBeNull();
    expect(got).toHaveLength(1);
  });

  it("JsonlSink appends every event; WebhookSink posts only episode events", async () => {
    const dir = tempDir();
    const calls: { url: string; body: string }[] = [];
    const fakeFetch = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: init.body });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const h = makeHarness(dir, { sinks: [new JsonlSink(join(dir, "events.jsonl")), new WebhookSink("http://orchestrator.invalid/hook", fakeFetch)] });
    await drive(h, 450);
    const lines = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; at: string });
    expect(lines.filter((l) => l.type === "probe.result")).toHaveLength(450);
    const episodeEvents = lines.filter((l) => l.type.startsWith("episode."));
    expect(episodeEvents.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(episodeEvents.length);
    expect(calls.every((c) => c.url === "http://orchestrator.invalid/hook")).toBe(true);
    expect(calls.map((c) => (JSON.parse(c.body) as { type: string }).type)).toEqual(episodeEvents.map((e) => e.type));
  });
});

describe("Sentinel.observe (live grounding)", () => {
  it("scores live answers on the model's live stream only", async () => {
    const dir = tempDir();
    const h = makeHarness(dir);
    const ok = await h.sentinel.observe({ answer: "Rated 450 kW.", sources: ["Generator: 450 kW"] });
    expect(ok.result).toMatchObject({ stream: "m|live", family: "live", pool: "live", role: "monitor", outcome: "correct", hallucinated: false, probeId: "live-0", seq: 0 });
    expect(ok.unsupported).toEqual([]);
    const bad = await h.sentinel.observe({ answer: "Rated 999 kW.", sources: ["Generator: 450 kW"], id: "req-7", host: { modelId: "other" } });
    expect(bad.result).toMatchObject({ stream: "other|live", probeId: "live-1", requestId: "req-7", hallucinated: true, outcome: "hallucinated", seq: 1 });
    expect(bad.unsupported).toEqual(["999"]);
    expect(bad.result.contextTokens).toBe(Math.round("Generator: 450 kW".length / 4));
    expect(h.sentinel.monitors.has("m|all")).toBe(false);
    expect(h.sentinel.monitors.get("m|live")!.count).toBe(1);
    // Probes continue the shared sequence.
    expect((await h.sentinel.probeOnce())!.seq).toBe(2);
  });

  it("opens an episode on the live stream when grounding failures rise", async () => {
    const opened: SentinelEvent[] = [];
    const s = makeHarness(tempDir(), { sinks: [{ emit: (e) => void (e.type === "episode.opened" && opened.push(e)) }] }).sentinel;
    for (let k = 0; k < 120; k++) {
      const grounded = k < 60 || k % 2 === 0 ? k % 25 !== 0 : false;
      await s.observe({ answer: grounded ? "450" : "451", sources: ["450"] });
    }
    expect(opened).toHaveLength(1);
    const ep = (opened[0] as Extract<SentinelEvent, { type: "episode.opened" }>).episode;
    expect(ep.stream).toBe("m|live");
    expect(ep.onsetSeq).toBeGreaterThanOrEqual(50);
  });
});

describe("Sentinel.run", () => {
  class FlipHost implements HostContextSource {
    checks = 0;
    constructor(private readonly busyFor: number) {}
    current() {
      this.checks++;
      return { modelId: "m", busy: this.checks <= this.busyFor };
    }
  }

  it("skips probes while the host is busy and stops at maxProbes", async () => {
    const host = new FlipHost(4);
    const model = fixedModel("NOT IN DOCUMENT");
    const s = new Sentinel({ model, host, dataDir: tempDir(), bands: [400], seed: 1 });
    await s.run({ intervalMs: 1, maxProbes: 3 });
    expect(s.allResults).toHaveLength(3);
    expect(model.calls).toBe(3);
    expect(host.checks).toBeGreaterThanOrEqual(4 + 3);
    expect(s.allResults.every((r) => r.host.busy === false)).toBe(true);
  });

  it("returns when aborted even if the host stays busy", async () => {
    const s = new Sentinel({ model: fixedModel("x"), host: new FlipHost(Infinity), dataDir: tempDir(), bands: [400] });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    await s.run({ intervalMs: 5, signal: ctl.signal });
    expect(s.allResults).toHaveLength(0);
  });

  it("stop() ends the loop", async () => {
    const s = new Sentinel({ model: fixedModel("x"), host: new PushedHostContext({ modelId: "m" }), dataDir: tempDir(), bands: [400] });
    setTimeout(() => s.stop(), 20);
    await s.run({ intervalMs: 2 });
    expect(s.allResults.length).toBeGreaterThan(0);
  });

  // Regression: run() used to leave one "abort" listener per sleep on the caller's signal.
  it("does not accumulate abort listeners on a long-lived signal", async () => {
    const s = new Sentinel({ model: fixedModel("x"), host: new PushedHostContext({ modelId: "m" }), dataDir: tempDir(), bands: [400] });
    const ctl = new AbortController();
    await s.run({ intervalMs: 0, maxProbes: 25, signal: ctl.signal });
    expect(getEventListeners(ctl.signal, "abort").length).toBeLessThanOrEqual(1);
  });
});

describe("PushedHostContext", () => {
  it("merges updates", () => {
    const h = new PushedHostContext({ modelId: "a", kvPressure: 0.1 });
    expect(h.push({ kvPressure: 0.9, busy: true })).toEqual({ modelId: "a", kvPressure: 0.9, busy: true });
    expect(h.current()).toEqual({ modelId: "a", kvPressure: 0.9, busy: true });
  });

  it("SENTINEL_POOL_RATIOS keeps most families on the monitor side", () => {
    expect(SENTINEL_POOL_RATIOS.train).toBeLessThan(0.5);
    expect(Object.values(SENTINEL_POOL_RATIOS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("creates the data directory", () => {
    const dir = join(tempDir(), "nested", "data");
    new Sentinel({ model: fixedModel("x"), host: new PushedHostContext({ modelId: "m" }), dataDir: dir, bands: [400] });
    expect(existsSync(dir)).toBe(true);
  });
});

describe("Sentinel — roles, invalid outcomes, strata", () => {
  it("bands must fit maxContextTokens with a 10% margin plus the answer budget", () => {
    const h = makeHarness(tempDir(), { bands: [400, 800, 900, 1000], maxContextTokens: 1000 });
    expect(h.sentinel.bands).toEqual([400, 800]); // 900·1.1 + 64 > 1000
    const big = makeHarness(tempDir(), { bands: [400, 800], maxContextTokens: 1000, model: { ...fixedModel("x"), maxTokens: 200 } });
    expect(big.sentinel.bands).toEqual([400]); // 800·1.1 + 200 > 1000
  });

  it("probes of retired families are logged as excluded and feed nothing", async () => {
    const pm = pools();
    const fam = generateProbe(2, 0, { bands: BANDS }).family;
    pm.retire(fam, "leaked into a prompt");
    const h = makeHarness(tempDir(), { pools: pm, model: fixedModel("999") });
    await drive(h, 60);
    const excluded = h.sentinel.allResults.filter((r) => r.role === "excluded");
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded.every((r) => r.family === fam && r.pool === "retired")).toBe(true);
    expect(h.sentinel.allResults.filter((r) => r.family === fam).every((r) => r.role === "excluded")).toBe(true);
    const charted = new Set([...h.sentinel.monitors.values()].flatMap((m) => m.observations.map((o) => o.probeId)));
    for (const r of excluded) expect(charted.has(r.probeId)).toBe(false);
    // Excluded hallucinations never become preference pairs either.
    expect(h.sentinel.pairSources().some((s) => s.family === fam)).toBe(false);
  });

  it("invalid answers are logged and counted but never charted", async () => {
    const reasons = ["", "length", "reasoning_only"];
    let n = 0;
    const model = {
      name: "m",
      async complete() {
        const k = n++ % 4;
        if (k === 0) return { text: "", latencyMs: 1 }; // scored: empty → invalid
        if (k === 1) return { text: "450 and then", latencyMs: 1, invalid: "length" };
        if (k === 2) return { text: "<think>hmm</think>", latencyMs: 1, invalid: "reasoning_only" };
        return { text: "NOT IN DOCUMENT", latencyMs: 1 };
      },
    };
    const h = makeHarness(tempDir(), { model, pools: undefined });
    await drive(h, 40);
    const st = h.sentinel.status();
    expect(st.outcomes.invalid).toBe(30);
    expect(st.invalidReasons).toEqual({ empty: 10, length: 10, reasoning_only: 10 });
    expect(reasons).toHaveLength(3);
    const invalid = h.sentinel.allResults.filter((r) => r.outcome === "invalid");
    expect(invalid).toHaveLength(30);
    expect(invalid.every((r) => !r.hallucinated && r.invalidReason)).toBe(true);
    // Only the 10 valid answers reach the streams (band stream + |all).
    expect(h.sentinel.monitors.get("m|all")!.count).toBe(10);
    const bandObs = [...h.sentinel.monitors.values()].filter((m) => !m.stream.endsWith("|all")).reduce((s, m) => s + m.count, 0);
    expect(bandObs).toBe(10);
    // Invalid results are still persisted and audited.
    expect(readFileSync(join(h.opts.dataDir, "probes.jsonl"), "utf8").trim().split("\n")).toHaveLength(40);
    expect(st.auditEntries).toBe(40);
  });

  it("the |all stream is stratified by band label", async () => {
    const h = makeHarness(tempDir());
    await drive(h, 200);
    const all = h.sentinel.monitors.get("m|all")!;
    expect(all.observations.every((o) => o.stratum === "400" || o.stratum === "800")).toBe(true);
    expect(Object.keys(all.baselines).sort()).toEqual(["400", "800"]);
    expect(Object.keys(h.sentinel.monitors.get("m|400")!.baselines)).toEqual(["400"]);
    const st = h.sentinel.status().streams.find((x) => x.stream === "m|all")!;
    expect(Object.keys(st.baselines).sort()).toEqual(["400", "800"]);
    expect(st.threshold).toBe(st.state === "episode" ? 3 : 5);
  });

  it("emits, audits and webhooks baseline.high for a stream that is bad from the start", async () => {
    const events: SentinelEvent[] = [];
    const h = makeHarness(tempDir(), { model: new SimulatedModel("m", () => 0.6, 3), pools: undefined, sinks: [{ emit: (e) => void events.push(e) }] });
    await drive(h, 80);
    const high = events.filter((e): e is Extract<SentinelEvent, { type: "baseline.high" }> => e.type === "baseline.high");
    expect(high.length).toBeGreaterThanOrEqual(2);
    expect(new Set(high.map((e) => e.stream))).toContain("m|all");
    for (const e of high) {
      expect(e.baseline).toBeGreaterThan(0.25);
      expect(["400", "800"]).toContain(e.stratum);
    }
    const audit = readFileSync(join(h.opts.dataDir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; payload: { stream?: string } });
    expect(audit.filter((e) => e.type === "baseline.high")).toHaveLength(high.length);
    // Not written to episodes.jsonl.
    expect(existsSync(join(h.opts.dataDir, "episodes.jsonl"))).toBe(false);
  });
});

describe("Sentinel — stream limit", () => {
  it("canMonitor reflects the maxStreams cap; observe on a new model past the cap throws RangeError", async () => {
    const h = makeHarness(tempDir(), { maxStreams: 4, pools: undefined, model: fixedModel("NOT IN DOCUMENT") });
    await drive(h, 13); // seq 0–11 are 400-token probes, seq 12 is 800: m|400, m|800, m|all
    expect(h.sentinel.canMonitor("m")).toBe(true);
    expect(h.sentinel.canMonitor("other")).toBe(false); // would need up to 3 more
    await h.sentinel.observe({ answer: "1", sources: ["1"] }); // m|live: 4 streams
    await expect(h.sentinel.observe({ answer: "1", sources: ["1"], host: { modelId: "other" } })).rejects.toBeInstanceOf(RangeError);
    expect(h.sentinel.monitors.size).toBe(4);
  });

  // Regression (fixed): record() appends the audit entry and the probes.jsonl line BEFORE ingest()
  // creates streams, so a result that hits the stream cap is persisted and then throws.
  // At the next start, replay() re-ingests that line, hits the same cap, and the
  // constructor throws: the data dir can no longer be opened. (/context accepts any
  // modelId, so pushing a new model past the cap is enough to trigger it; POST /observe
  // for a model whose |live stream is past the cap does the same and returns 429 after
  // the line was already written.)
  it("a result rejected by the stream cap does not make the data dir unreplayable", async () => {
    const dir = tempDir();
    const h = makeHarness(dir, { maxStreams: 3, pools: undefined, bands: [400], model: fixedModel("NOT IN DOCUMENT") });
    await h.sentinel.probeOnce(); // m|400, m|all
    h.host.push({ modelId: "m2" });
    await h.sentinel.probeOnce().catch(() => undefined); // creates m2|400, then m2|all throws
    expect(() => makeHarness(dir, { maxStreams: 3, pools: undefined, bands: [400], model: fixedModel("x") })).not.toThrow();
  });
});

describe("Sentinel — replay integrity", () => {
  it("drops probes.jsonl lines whose answer does not match the audit chain", async () => {
    const dir = tempDir();
    const a = makeHarness(dir);
    await drive(a, 60);
    const path = join(dir, "probes.jsonl");
    const ls = readFileSync(path, "utf8").trim().split("\n");
    const victim = JSON.parse(ls[10]!) as ProbeResult;
    const forged = { ...victim, answer: `${victim.answer} (edited)`, outcome: "correct", hallucinated: false };
    ls[10] = JSON.stringify(forged);
    ls.splice(20, 0, "{not json");
    writeFileSync(path, `${ls.join("\n")}\n`);
    const b = makeHarness(dir);
    expect(b.sentinel.replayRejected).toBe(2);
    expect(b.sentinel.status().probes).toBe(59);
    expect(b.sentinel.status().replayRejected).toBe(2);
    expect(b.sentinel.allResults.some((r) => r.probeId === victim.probeId)).toBe(false);
  });

  it("a forged line for a probe that was never audited is rejected", async () => {
    const dir = tempDir();
    const a = makeHarness(dir);
    await drive(a, 5);
    const r = a.sentinel.allResults[0]!;
    appendFileSync(join(dir, "probes.jsonl"), `${JSON.stringify({ ...r, probeId: "p2-999", seq: 999, probeSeq: 999 })}\n`);
    const b = makeHarness(dir);
    expect(b.sentinel.replayRejected).toBe(1);
    expect(b.sentinel.status().probes).toBe(5);
    expect((await b.sentinel.probeOnce())!.seq).toBe(5); // the forged seq does not advance the counter
  });

  it("pairSources skips results whose logged reference does not match the regenerated probe", async () => {
    const dir = tempDir();
    const a = makeHarness(dir);
    await drive(a, 300);
    const sources = a.sentinel.pairSources();
    expect(sources.length).toBeGreaterThan(1);
    const path = join(dir, "probes.jsonl");
    const ls = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ProbeResult);
    const target = ls.find((r) => r.probeId === sources[0]!.probeId)!;
    target.reference = "tampered";
    writeFileSync(path, `${ls.map((r) => JSON.stringify(r)).join("\n")}\n`);
    const b = makeHarness(dir);
    expect(b.sentinel.replayRejected).toBe(0); // answer unchanged
    expect(b.sentinel.pairSources().map((s) => s.probeId)).toEqual(sources.slice(1).map((s) => s.probeId));
  });

  it("repairs torn tails at startup and keeps going", async () => {
    const dir = tempDir();
    const a = makeHarness(dir);
    await drive(a, 10);
    appendFileSync(join(dir, "probes.jsonl"), '{"probeId":"p2-10","fam');
    appendFileSync(join(dir, "audit.jsonl"), '{"seq":10,"ts":"20');
    const b = makeHarness(dir);
    expect(b.sentinel.repairedFiles.sort()).toEqual([join(dir, "audit.jsonl"), join(dir, "probes.jsonl")].sort());
    expect(b.sentinel.status().probes).toBe(10);
    expect(b.sentinel.replayRejected).toBe(0);
    b.tick.i = 10;
    await drive(b, 2);
    expect(verifyAuditLog(readFileSync(join(dir, "audit.jsonl"), "utf8"), AUDIT_KEY)).toMatchObject({ ok: true, count: 12 });
  });

  // Regression (fixed): replay matched probes.jsonl lines to audit entries by probeId only
  // (answerHashes: Map<probeId, sha256>). /observe accepts a caller-chosen `id`, so two
  // live observations with the same id keep only the LAST hash; at restart the first,
  // genuine line is counted as tampered (replayRejected) and dropped, and the rebuilt
  // state differs from the state before the restart.
  it("replay keeps live observations that reuse a caller-supplied id", async () => {
    const dir = tempDir();
    const a = makeHarness(dir);
    await a.sentinel.observe({ answer: "450", sources: ["450"], id: "req-1" });
    await a.sentinel.observe({ answer: "999", sources: ["450"], id: "req-1" });
    const before = a.sentinel.status();
    const b = makeHarness(dir);
    expect(b.sentinel.replayRejected).toBe(0);
    expect(b.sentinel.status().outcomes).toEqual(before.outcomes);
  });
});

describe("repairTail", () => {
  it("cuts a file back to its last complete line", () => {
    const p = join(tempDir(), "f.jsonl");
    writeFileSync(p, '{"a":1}\n{"b":2}\n{"c":');
    expect(repairTail(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe('{"a":1}\n{"b":2}\n');
    expect(repairTail(p)).toBe(false);
    expect(readFileSync(p, "utf8")).toBe('{"a":1}\n{"b":2}\n');
  });

  it("returns false for missing and empty files", () => {
    const dir = tempDir();
    expect(repairTail(join(dir, "nope"))).toBe(false);
    writeFileSync(join(dir, "empty"), "");
    expect(repairTail(join(dir, "empty"))).toBe(false);
  });

  it("empties a file that has no complete line", () => {
    const p = join(tempDir(), "f.jsonl");
    writeFileSync(p, '{"torn":');
    expect(repairTail(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("");
  });

  it("finds the last newline more than one 64 KiB chunk back", () => {
    const p = join(tempDir(), "f.jsonl");
    const head = '{"ok":true}\n';
    writeFileSync(p, head + "x".repeat(200_000));
    expect(repairTail(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe(head);
  });
});
