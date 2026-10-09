import { describe, expect, it } from "vitest";
import { attribute, DEFAULT_MONITOR, StreamMonitor, type MonitorEvent, type Observation } from "../src/episodes.js";
import type { Episode, HostContext } from "../src/types.js";
import { bernoulli, observations, repeat } from "./helpers.js";

const feed = (m: StreamMonitor, obs: Observation[]): MonitorEvent[] => obs.flatMap((o) => m.add(o));
const episodeEvents = (ev: MonitorEvent[]) => ev.filter((e) => e.type !== "baseline_high") as (MonitorEvent & { episode: Episode })[];

/** n observations with exactly k ones, spread evenly (keeps warmup halves balanced). */
function spread(n: number, k: number): (0 | 1)[] {
  const xs: (0 | 1)[] = repeat(0, n);
  for (let j = 0; j < k; j++) xs[Math.floor(((j + 0.5) * n) / k)] = 1;
  return xs;
}

describe("defaults", () => {
  it("match the documented values", () => {
    expect(DEFAULT_MONITOR).toMatchObject({ warmup: 100, minStratum: 60, shrink: 10, onsetLookback: 400, minSegment: 5, h: 5, hRecovery: 3 });
  });
});

describe("StreamMonitor warmup and baselines", () => {
  it("stays in warmup until `warmup` observations, then shrinks the baseline toward the pooled rate", () => {
    const m = new StreamMonitor("m|1k");
    const xs = spread(100, 6);
    const obs = observations(xs);
    for (const o of obs.slice(0, 99)) {
      expect(m.add(o)).toEqual([]);
      expect(m.state).toBe("warmup");
      expect(m.baseline).toBeUndefined();
    }
    m.add(obs[99]!);
    expect(m.state).toBe("normal");
    const pooled = (6 + 0.5) / (100 + 1);
    const p0 = (6 + 10 * pooled) / (100 + 10);
    expect(m.baselines).toEqual({ _: Math.round(p0 * 1000) / 1000 });
    expect(m.baseline).toBeCloseTo(p0, 10);
    expect(m.count).toBe(100);
    expect(m.statistic).toBe(0);
    expect(m.unstableStrata).toEqual([]);
  });

  it("waits for warmupEvents hallucinations unless maxWarmup is reached; clamps at 0.002", () => {
    const m = new StreamMonitor("s", { ...DEFAULT_MONITOR, maxWarmup: 150 });
    feed(m, observations(repeat(0, 149)));
    expect(m.state).toBe("warmup");
    m.add(observations(repeat(0, 150))[149]!);
    expect(m.state).toBe("normal");
    // p̄ = 0.5/151, p0 = 10·p̄/160 ≈ 0.0002 → clamped.
    expect(m.baseline).toBe(0.002);
  });

  it("gives each stratum its own baseline shrunk toward the pooled rate", () => {
    // minStratum 100 makes warmup end exactly at observation 200.
    const m = new StreamMonitor("m|all", { ...DEFAULT_MONITOR, minStratum: 100 });
    const a = spread(100, 2);
    const b = spread(100, 20);
    const obs: Observation[] = [];
    for (let i = 0; i < 100; i++) {
      obs.push({ seq: 2 * i, at: `${2 * i}`, x: a[i]!, probeId: `a${i}`, host: { modelId: "m" }, stratum: "1k" });
      obs.push({ seq: 2 * i + 1, at: `${2 * i + 1}`, x: b[i]!, probeId: `b${i}`, host: { modelId: "m" }, stratum: "32k" });
    }
    feed(m, obs);
    const pooled = (22 + 0.5) / (200 + 1);
    const want = (k: number) => Math.round(((k + 10 * pooled) / (100 + 10)) * 1000) / 1000;
    expect(m.baselines).toEqual({ "1k": want(2), "32k": want(20) });
    expect(m.baselines["1k"]!).toBeLessThan(m.baselines["32k"]!);
    // A stratum first seen after warmup starts from the pooled rate.
    m.add({ seq: 999, at: "999", x: 0, probeId: "c", host: { modelId: "m" }, stratum: "4k" });
    expect(m.baselines["4k"]).toBe(Math.round(pooled * 1000) / 1000);
  });

  it("waits until every stratum has minStratum observations", () => {
    const m = new StreamMonitor("m|all");
    const obs: Observation[] = [];
    const a = spread(150, 8);
    for (let i = 0; i < 150; i++) obs.push({ seq: i, at: `${i}`, x: a[i]!, probeId: `a${i}`, host: { modelId: "m" }, stratum: i % 5 === 0 ? "thin" : "thick" });
    feed(m, obs);
    expect(m.state).toBe("warmup"); // "thin" has 30 < 60
    for (let i = 0; i < 30; i++) m.add({ seq: 200 + i, at: "", x: 0, probeId: `t${i}`, host: { modelId: "m" }, stratum: "thin" });
    expect(m.state).toBe("normal");
  });

  it("baseline is clamped to [0.002, 0.9]; a configured baseline skips warmup", () => {
    const lo = new StreamMonitor("s", { ...DEFAULT_MONITOR, baseline: 0 });
    lo.add(observations([0])[0]!);
    expect(lo.baselines).toEqual({ _: 0.002 });
    const hi = new StreamMonitor("s", { ...DEFAULT_MONITOR, baseline: 0.99 });
    hi.add(observations([0])[0]!);
    expect(hi.baselines).toEqual({ _: 0.9 });
    const m = new StreamMonitor("s", { ...DEFAULT_MONITOR, baseline: 0.05 });
    const ev = feed(m, observations(repeat(1, 6)));
    expect(m.baselines).toEqual({ _: 0.05 });
    expect(ev.map((e) => e.type)).toEqual(["opened"]);
    expect(ev[0]!.episode!.onsetSeq).toBe(0);
  });

  it("emits baseline_high when a stratum's baseline is above maxBaseline", () => {
    const m = new StreamMonitor("s");
    const ev = feed(m, observations(spread(100, 40)));
    expect(ev).toEqual([{ type: "baseline_high", stratum: "_", baseline: m.baselines._ }]);
    expect(m.baselines._!).toBeGreaterThan(0.25);
    const quiet = new StreamMonitor("s");
    expect(feed(quiet, observations(spread(100, 6)))).toEqual([]);
  });

  it("restarts warmup when its two halves disagree (episode during warmup)", () => {
    // A burst at the very start, then a clean stream: the first warmup window's halves differ
    // sharply, so the burst is dropped instead of inflating the baseline.
    const xs: (0 | 1)[] = [...spread(50, 20), ...spread(300, 6)];
    const m = new StreamMonitor("s");
    feed(m, observations(xs));
    expect(m.state).toBe("normal");
    expect(m.baselines._!).toBeLessThan(0.05);
    // Without the restart the estimate would include the burst (26/350 ≈ 0.074 before shrinkage).
  });

  // Regression (fixed): a restart used to set the warmup count back to the second half (wn = n2), so with
  // recurring instability wn never reaches maxWarmup: the stream stays in warmup
  // forever (never charted), and `unstable`/unstableStrata is never set.
  // Repro: alternating blocks of 50 clean / 50 hallucinated, 6000 observations.
  it("a stream that never stabilises is charted and flagged unstable after maxWarmup observations", () => {
    const m = new StreamMonitor("s");
    const xs: (0 | 1)[] = [];
    while (xs.length < 6000) xs.push(...repeat(0, 50), ...repeat(1, 50));
    feed(m, observations(xs));
    expect(m.state).not.toBe("warmup");
    expect(m.unstableStrata).toEqual(["_"]);
  });

  it("recentRate covers the last window", () => {
    const m = new StreamMonitor("s");
    expect(m.recentRate()).toBe(0);
    feed(m, observations([...repeat(1, 10), ...repeat(0, 40)]));
    expect(m.recentRate(50)).toBeCloseTo(0.2);
    expect(m.recentRate(40)).toBe(0);
  });

  it("keeps at most ~maxObservations in memory but counts all", () => {
    const m = new StreamMonitor("s", { ...DEFAULT_MONITOR, maxObservations: 100 });
    feed(m, observations(bernoulli(1000, () => 0.03, 2)));
    expect(m.count).toBe(1000);
    expect(m.observations.length).toBeLessThanOrEqual(125);
    expect(m.observations.at(-1)!.seq).toBe(999);
  });
});

describe("StreamMonitor detection", () => {
  const truthOn = 400;
  const truthOff = 600;

  function planted(seed: number) {
    const xs = bernoulli(1000, (i) => (i >= truthOn && i < truthOff ? 0.4 : 0.03), seed);
    const host = (i: number): HostContext => ({
      modelId: "m",
      checkpoint: "c1",
      quantization: i >= truthOn && i < truthOff ? "q4" : "q8",
      thermalDerate: i >= truthOn && i < truthOff ? 0.4 + (i % 4) / 100 : 0.02 + (i % 3) / 100,
      kvPressure: 0.4 + (i % 5) / 100,
      queueDepth: i % 3,
    });
    const m = new StreamMonitor("m|4k");
    const events = feed(m, observations(xs, host));
    return { m, events };
  }

  it("opens on a planted shift with onset near truth and closes after the return", () => {
    for (const seed of [1, 2, 3]) {
      const { m, events } = planted(seed);
      // The planted episode is the first one; seed 1 also has one short false alarm later (#893–927).
      const eps = episodeEvents(events).slice(0, 2);
      expect(eps.map((e) => e.type)).toEqual(["opened", "closed"]);
      const [opened, closed] = eps as [(typeof eps)[0], (typeof eps)[0]];
      expect(opened.episode.state).toBe("open");
      expect(Math.abs(opened.episode.onsetSeq - truthOn)).toBeLessThanOrEqual(25);
      expect(opened.episode.detectedSeq).toBeGreaterThanOrEqual(opened.episode.onsetSeq);
      expect(opened.episode.detectedSeq - truthOn).toBeLessThan(60);
      expect(closed.episode.id).toBe(opened.episode.id);
      expect(closed.episode.state).toBe("closed");
      expect(Math.abs(closed.episode.endSeq! - truthOff)).toBeLessThanOrEqual(30);
      expect(closed.episode.episodeRate).toBeGreaterThan(0.25);
      expect(closed.episode.baselineRate).toBeLessThan(0.1);
      expect(closed.episode.probes).toBe(closed.episode.endSeq! - closed.episode.onsetSeq);
      expect(closed.episode.evidence.length).toBeGreaterThan(0);
      expect(closed.episode.evidence.length).toBeLessThanOrEqual(25);
      expect(closed.episode.attach).toEqual({ model: "m", checkpoint: "c1", quantization: closed.episode.hostAtOnset.quantization });
      expect(closed.episode.band).toBe("4k");
      expect(closed.episode.retrospective).toBeUndefined();
      expect(m.episodes.filter((e) => e.onsetSeq < truthOff && e.endSeq! > truthOn)).toHaveLength(1);
      for (const e of m.episodes.slice(1)) expect(e.probes).toBeLessThan(50);
      expect(m.state).toBe("normal");
      expect(m.current).toBeUndefined();
    }
  });

  it("ranks the planted host factor first in attribution", () => {
    const ep = episodeEvents(planted(2).events).at(-1)!.episode;
    expect(ep.attribution[0]!.factor).toBe("thermalDerate");
    expect(ep.attribution[0]!.effect).toBeGreaterThan(3);
    expect(ep.attribution.find((a) => a.factor === "kvPressure")!.effect).toBeLessThan(1);
    expect(ep.attribution.find((a) => a.factor === "quantization")).toEqual({ factor: "quantization", baseline: "q8", inEpisode: "q4", effect: 1 });
    expect(ep.attribution.find((a) => a.factor === "checkpoint")).toBeUndefined();
  });

  it("returns snapshots, not live references", () => {
    const { events, m } = planted(1);
    episodeEvents(events)[0]!.episode.probes = -1;
    expect(m.episodes[0]!.probes).not.toBe(-1);
  });

  it("reports state and statistic while an episode is open", () => {
    const m = new StreamMonitor("s", { ...DEFAULT_MONITOR, baseline: 0.05 });
    feed(m, observations(repeat(1, 6)));
    expect(m.state).toBe("episode");
    expect(m.current?.state).toBe("open");
    expect(m.statistic).toBe(0);
  });

  it("stays quiet on an in-control stream", () => {
    for (const seed of [6, 7]) {
      const m = new StreamMonitor("s");
      expect(episodeEvents(feed(m, observations(bernoulli(3000, () => 0.03, seed))))).toEqual([]);
    }
  });

  it("tests each stratum against its own baseline (no alarms from band mixing)", () => {
    const m = new StreamMonitor("m|all");
    const r1 = bernoulli(3000, () => 0.01, 6);
    const r2 = bernoulli(3000, () => 0.15, 7);
    const obs: Observation[] = [];
    for (let i = 0; i < 3000; i++) {
      const hiBand = i % 2 === 1;
      obs.push({ seq: i, at: `${i}`, x: (hiBand ? r2 : r1)[i]!, probeId: `o${i}`, host: { modelId: "m" }, stratum: hiBand ? "32k" : "1k" });
    }
    expect(episodeEvents(feed(m, obs))).toEqual([]);
    expect(Object.keys(m.baselines).sort()).toEqual(["1k", "32k"]);
  });

  it("the onset search starts no earlier than the end of the previous episode", () => {
    const m = new StreamMonitor("s", { ...DEFAULT_MONITOR, baseline: 0.05 });
    const ev = episodeEvents(feed(m, observations([...repeat(0, 100), ...repeat(1, 20), ...repeat(0, 100), ...repeat(1, 10), ...repeat(0, 40)])));
    const second = ev.filter((e) => e.type === "opened")[1]!.episode;
    expect(second.id).not.toBe(m.episodes[0]!.id);
    expect(second.onsetSeq).toBeGreaterThanOrEqual(m.episodes[0]!.endSeq!);
  });
});

describe("StreamMonitor reopen and split", () => {
  // Fixed baseline 0.05 → p1 0.15. Up chart: +1.10 per 1. Down chart (hRecovery 3): +0.111 per 0, −1.10 per 1.
  const cfg = { ...DEFAULT_MONITOR, baseline: 0.05, h: 5, hRecovery: 3, reopenWithin: 30 };
  const head: (0 | 1)[] = [...repeat(0, 100), ...repeat(1, 20), ...repeat(0, 30)];

  it("a closed episode is confirmed after enough clean observations", () => {
    const ev = episodeEvents(feed(new StreamMonitor("s", cfg), observations(head)));
    expect(ev.map((e) => e.type)).toEqual(["opened", "closed"]);
    expect(ev[0]!.episode.onsetSeq).toBe(100);
    expect(ev[1]!.episode.endSeq).toBe(120);
    expect(ev[1]!.episode.hallucinations).toBe(20);
    expect(ev[1]!.episode.probes).toBe(20);
  });

  it("an alarm within reopenWithin reopens the same episode", () => {
    const m = new StreamMonitor("s", cfg);
    const ev = episodeEvents(feed(m, observations([...head, ...repeat(0, 5), ...repeat(1, 10), ...repeat(0, 40)])));
    // The reopen is announced live; at the final close the 35-probe clean gap
    // between the bursts is clear enough to split, so the second burst is
    // reported as its own (retrospective) episode.
    expect(ev.map((e) => e.type)).toEqual(["opened", "closed", "opened", "closed", "closed"]);
    expect(ev[4]!.episode.retrospective).toBe(true);
    expect(ev[2]!.episode.id).toBe(ev[0]!.episode.id);
    expect(ev[2]!.episode.state).toBe("open");
    expect(ev[2]!.episode.endSeq).toBeUndefined();
    expect(ev[2]!.episode.reopened).toBe(1);
    expect(ev[2]!.episode.detectedSeq).toBe(104);
    expect(ev[2]!.episode.hallucinations).toBe(25);
    expect(m.episodes).toHaveLength(2);
    expect(m.episodes.every((e) => e.state === "closed")).toBe(true);
  });

  // Regression: the end search used to span the whole episode, so the first,
  // larger burst won and the burst that caused the reopen was reported nowhere.
  it("a reopened episode's final report still covers the burst that reopened it", () => {
    const m = new StreamMonitor("s", cfg);
    feed(m, observations([...head, ...repeat(0, 5), ...repeat(1, 10), ...repeat(0, 40)]));
    expect(m.episodes.at(-1)!.endSeq!).toBeGreaterThanOrEqual(159);
    expect(m.episodes.reduce((s, e) => s + e.hallucinations, 0)).toBe(30);
  });

  it("an alarm after reopenWithin starts a new episode", () => {
    const m = new StreamMonitor("s", cfg);
    const ev = episodeEvents(feed(m, observations([...head, ...repeat(0, 40), ...repeat(1, 10), ...repeat(0, 40)])));
    expect(ev.map((e) => e.type)).toEqual(["opened", "closed", "opened", "closed"]);
    expect(m.episodes).toHaveLength(2);
    expect(m.episodes[1]!.reopened).toBeUndefined();
    expect(m.episodes[1]!.onsetSeq).toBe(190);
    expect(m.episodes[1]!.endSeq).toBe(200);
  });

  const gap: (0 | 1)[] = [];
  for (let k = 0; k < 3; k++) gap.push(...repeat(0, 11), 1);

  it("splits a closed episode at an interior recovery gap; the second part is retrospective", () => {
    const m = new StreamMonitor("s", cfg);
    const ev = episodeEvents(feed(m, observations([...repeat(0, 100), ...repeat(1, 10), ...gap, ...repeat(1, 30), ...repeat(0, 60)])));
    expect(ev.map((e) => e.type)).toEqual(["opened", "closed", "closed"]);
    const [first, second] = m.episodes as [Episode, Episode];
    expect(first.onsetSeq).toBe(100);
    expect(first.endSeq).toBe(110);
    expect(first.hallucinations).toBe(10);
    expect(first.retrospective).toBeUndefined();
    expect(second.splitFrom).toBe(first.id);
    expect(second.retrospective).toBe(true);
    expect(second.onsetSeq).toBe(145);
    expect(second.endSeq).toBe(176);
    expect(second.hallucinations).toBe(31);
    expect(ev[1]!.episode.endSeq).toBe(110);
    expect(ev[2]!.episode.id).toBe(second.id);
  });

  // Regression (fixed): with the first burst at least as large as the second, the end
  // MLE picks the end of the first burst (#120) and the gap search only covers [100, 120):
  // the second burst (20 hallucinations at #156–175) is reported nowhere.
  it("merged bursts of equal size are both reported", () => {
    const m = new StreamMonitor("s", cfg);
    feed(m, observations([...repeat(0, 100), ...repeat(1, 20), ...gap, ...repeat(1, 20), ...repeat(0, 60)]));
    expect(m.episodes.reduce((s, e) => s + e.hallucinations, 0)).toBeGreaterThanOrEqual(40);
    expect(m.episodes.at(-1)!.endSeq!).toBeGreaterThanOrEqual(175);
  });

  it("contextTokens on observations are attributed", () => {
    const m = new StreamMonitor("s", cfg);
    const obs = observations([...repeat(0, 100), ...repeat(1, 20), ...repeat(0, 30)]).map((o, i) => ({ ...o, contextTokens: i >= 100 && i < 120 ? 32000 + (i % 3) : 1000 + (i % 3) }));
    const ep = episodeEvents(feed(m, obs)).at(-1)!.episode;
    expect(ep.attribution[0]!.factor).toBe("contextTokens");
  });
});

describe("attribute", () => {
  const o = (host: HostContext, contextTokens?: number): Observation => ({ seq: 0, at: "", x: 0, probeId: "x", host, ...(contextTokens !== undefined ? { contextTokens } : {}) });
  it("ranks by standardized effect and handles extra signals and categorical changes", () => {
    const before = [0, 1, 2, 3, 4].map((i) => o({ modelId: "a", kvPressure: 0.4 + i / 100, gpuTempC: 60 + i, extra: { fan: 1000 + i } }));
    const during = [0, 1, 2, 3, 4].map((i) => o({ modelId: "b", kvPressure: 0.41 + i / 100, gpuTempC: 90 + i, extra: { fan: 3000 + i } }));
    const a = attribute(before, during);
    expect(a.map((x) => x.factor).slice(0, 2).sort()).toEqual(["extra.fan", "gpuTempC"]);
    expect(a.find((x) => x.factor === "modelId")).toEqual({ factor: "modelId", baseline: "a", inEpisode: "b", effect: 1 });
    expect(a.find((x) => x.factor === "kvPressure")!.effect).toBeLessThan(1);
    for (let k = 1; k < a.length; k++) expect(a[k - 1]!.effect).toBeGreaterThanOrEqual(a[k]!.effect);
  });

  it("uses contextTokens from observations", () => {
    const a = attribute([1, 2, 3].map((i) => o({ modelId: "a" }, 1000 + i)), [1, 2, 3].map((i) => o({ modelId: "a" }, 32000 + i)));
    expect(a[0]!.factor).toBe("contextTokens");
  });

  it("skips factors with fewer than 3 values on either side and non-finite values", () => {
    expect(attribute([o({ modelId: "a", kvPressure: 0.1 })], [o({ modelId: "a", kvPressure: 0.9 })])).toEqual([]);
    expect(attribute([1, 2, 3].map(() => o({ modelId: "a", kvPressure: Number.NaN })), [1, 2, 3].map(() => o({ modelId: "a", kvPressure: 0.5 })))).toEqual([]);
  });

  it("constant but different values get the capped effect 10", () => {
    const b = [1, 2, 3].map(() => o({ modelId: "a", queueDepth: 0 }));
    const d = [1, 2, 3].map(() => o({ modelId: "a", queueDepth: 5 }));
    expect(attribute(b, d)).toEqual([{ factor: "queueDepth", baseline: 0, inEpisode: 5, effect: 10 }]);
  });
});
