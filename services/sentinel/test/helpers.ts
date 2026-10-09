import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mulberry32 } from "@grahmos/gate";
import { PoolManager } from "@grahmos/trainloop";
import type { Observation } from "../src/episodes.js";
import { SimulatedModel, type ModelClient } from "../src/model.js";
import { PushedHostContext, Sentinel, SENTINEL_POOL_RATIOS, type SentinelOptions } from "../src/sentinel.js";
import type { HostContext } from "../src/types.js";

export const tempDir = (prefix = "sentinel-test-") => mkdtempSync(join(tmpdir(), prefix));

export const SALT = "sentinel-test-salt-000000";
export const pools = () => new PoolManager({ salt: SALT, ratios: SENTINEL_POOL_RATIOS });

export const T0 = Date.parse("2026-10-09T00:00:00Z");
export const at = (i: number) => new Date(T0 + i * 1000).toISOString();

/** Builds observations from a 0/1 array with optional per-index host. */
export function observations(xs: (0 | 1)[], host: (i: number) => HostContext = () => ({ modelId: "m" })): Observation[] {
  return xs.map((x, i) => ({ seq: i, at: at(i), x, probeId: `o${i}`, host: host(i) }));
}

/** Bernoulli sequence with a rate per index, from a seeded source. */
export function bernoulli(n: number, rate: (i: number) => number, seed = 1): (0 | 1)[] {
  const r = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => (r() < rate(i) ? 1 : 0));
}

export const repeat = (x: 0 | 1, n: number): (0 | 1)[] => Array.from({ length: n }, () => x);

/** A tiny scenario: low rate, an episode in [from, to), low rate again. Small bands keep it fast. */
export interface Harness {
  sentinel: Sentinel;
  host: PushedHostContext;
  /** Probe clock: index of the next probe. */
  tick: { i: number };
  opts: SentinelOptions;
}

export const EPISODE = { from: 150, to: 300 };
export const BANDS = [400, 800];
export const FAST_MONITOR = { warmup: 30, minStratum: 20, attributionWindow: 60 };

export function hostAtTick(i: number): HostContext {
  const hot = i >= EPISODE.from && i < EPISODE.to;
  return { modelId: "m", checkpoint: "ckpt-1", quantization: "q8_0", thermalDerate: hot ? 0.4 + (i % 5) / 100 : 0.02 + (i % 3) / 100, kvPressure: 0.4 + (i % 7) / 100, busy: false };
}

export function makeHarness(dataDir: string, over: Partial<SentinelOptions> = {}): Harness {
  const tick = { i: 0 };
  const host = new PushedHostContext(hostAtTick(0));
  const opts: SentinelOptions = {
    model: new SimulatedModel("m", () => (tick.i >= EPISODE.from && tick.i < EPISODE.to ? 0.6 : 0.03), 5),
    host,
    dataDir,
    pools: pools(),
    bands: BANDS,
    seed: 2,
    monitor: FAST_MONITOR,
    now: () => new Date(T0 + tick.i * 1000),
    auditKey: "audit-key-for-tests",
    ...over,
  };
  return { sentinel: new Sentinel(opts), host, tick, opts };
}

export async function drive(h: Harness, n: number): Promise<void> {
  for (let k = 0; k < n; k++) {
    h.host.push(hostAtTick(h.tick.i));
    await h.sentinel.probeOnce();
    h.tick.i++;
  }
}

/** Model that answers a fixed text (or a function of the call count). */
export function fixedModel(text: string | ((n: number) => string), name = "m"): ModelClient & { calls: number } {
  const m = {
    name,
    calls: 0,
    async complete() {
      const t = typeof text === "string" ? text : text(m.calls);
      m.calls++;
      return { text: t, latencyMs: 1 };
    },
  };
  return m;
}
