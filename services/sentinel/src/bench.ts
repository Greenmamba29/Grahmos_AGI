import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PoolManager } from "@grahmos/trainloop";
import type { MonitorConfig } from "./episodes.js";
import { SimulatedModel } from "./model.js";
import { hostAt, SCENARIO, SCENARIO_LENGTH, scenarioRate } from "./scenario.js";
import { PushedHostContext, Sentinel, SENTINEL_POOL_RATIOS } from "./sentinel.js";

/**
 * Detection benchmark against the known scenario: for each seed, run the
 * full scenario and match detected episodes to true ones per stream.
 *  - miss:       a true episode with no overlapping detection
 *  - fragment:   extra detections for the same true episode
 *  - false alarm: a detection overlapping no true episode
 *  - onset/end error: estimated minus true, in probes
 *  - delay:      alarm time minus true onset, in probes
 */
export interface BenchResult {
  seeds: number;
  windows: number;
  misses: number;
  fragments: number;
  falseAlarms: number;
  onsetError: { median: number; mae: number };
  endError: { median: number; mae: number };
  delay: { median: number; p90: number };
  missesByStream: Record<string, number>;
  /** One row per true window: what was detected for it (onset/detected/end are probe numbers). */
  details: { seed: number; stream: string; from: number; to: number; onset?: number; detected?: number; end?: number; parts: number }[];
}

function truthFor(stream: string): [number, number][] {
  const band = stream.split("|")[1]!;
  return SCENARIO.filter((r) => band === "all" || !r.bands || r.bands.some((b) => `${Math.round(b / 1000)}k` === band)).map((r) => [r.from, r.to]);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};
const mae = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, v) => s + Math.abs(v), 0) / xs.length) : NaN);

export async function benchDetection(opts: { seeds?: number; monitor?: Partial<MonitorConfig> } = {}): Promise<BenchResult> {
  const seeds = opts.seeds ?? 10;
  const r: BenchResult = { seeds, windows: 0, misses: 0, fragments: 0, falseAlarms: 0, onsetError: { median: 0, mae: 0 }, endError: { median: 0, mae: 0 }, delay: { median: 0, p90: 0 }, missesByStream: {}, details: [] };
  const onset: number[] = [];
  const end: number[] = [];
  const delay: number[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const dir = mkdtempSync(join(tmpdir(), "sentinel-bench-"));
    try {
      let i = 0;
      const host = new PushedHostContext(hostAt(0, "m"));
      const s = new Sentinel({
        model: new SimulatedModel("m", scenarioRate(() => i), seed * 13),
        host,
        dataDir: dir,
        seed,
        monitor: opts.monitor,
        pools: new PoolManager({ salt: `bench-salt-${seed}-padding-xx`, ratios: SENTINEL_POOL_RATIOS }),
      });
      for (i = 0; i < SCENARIO_LENGTH; i++) {
        host.push(hostAt(i, "m"));
        await s.probeOnce();
      }
      const eps = s.episodes();
      for (const stream of ["m|all", "m|1k", "m|4k", "m|16k", "m|32k"]) {
        const mine = eps.filter((e) => e.stream === stream);
        const truth = truthFor(stream);
        const overlaps = (e: (typeof mine)[number], a: number, b: number) => e.onsetSeq < b + 150 && (e.endSeq ?? SCENARIO_LENGTH) > a;
        for (const [a, b] of truth) {
          r.windows++;
          const hit = mine.filter((e) => overlaps(e, a, b));
          r.details.push({ seed, stream, from: a, to: b, onset: hit[0]?.onsetSeq, detected: hit[0]?.detectedSeq, end: hit.at(-1)?.endSeq, parts: hit.length });
          if (!hit.length) {
            r.misses++;
            r.missesByStream[stream] = (r.missesByStream[stream] ?? 0) + 1;
            continue;
          }
          r.fragments += hit.length - 1;
          onset.push(hit[0]!.onsetSeq - a);
          delay.push(hit[0]!.detectedSeq - a);
          end.push((hit.at(-1)!.endSeq ?? SCENARIO_LENGTH) - b);
        }
        r.falseAlarms += mine.filter((e) => !truth.some(([a, b]) => overlaps(e, a, b))).length;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  r.onsetError = { median: median(onset), mae: mae(onset) };
  r.endError = { median: median(end), mae: mae(end) };
  const sd = [...delay].sort((a, b) => a - b);
  r.delay = { median: median(delay), p90: sd[Math.floor(sd.length * 0.9)] ?? NaN };
  return r;
}
