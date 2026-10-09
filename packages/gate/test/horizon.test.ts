import { describe, expect, it } from "vitest";
import { crossing, estimateHorizons, fitLogistic, hierarchicalResample, logit, MIN_IDENTIFYING_SLOPE, predict, weightsFor, type HorizonPoint } from "../src/horizon.js";
import { mulberry32 } from "../src/util.js";

const sig = (z: number) => 1 / (1 + Math.exp(-z));

/** Simulated data: P(success) = sigmoid(slope * (log2 h50 - log2 minutes)). */
function simulate(opts: { h50: number; slope: number; tasks: number; runs: number; seed: number; minM?: number; maxM?: number; families?: number }): HorizonPoint[] {
  const rand = mulberry32(opts.seed);
  const lo = Math.log2(opts.minM ?? 1);
  const hi = Math.log2(opts.maxM ?? 2000);
  const out: HorizonPoint[] = [];
  for (let t = 0; t < opts.tasks; t++) {
    const minutes = 2 ** (lo + ((hi - lo) * t) / (opts.tasks - 1));
    const p = sig(opts.slope * (Math.log2(opts.h50) - Math.log2(minutes)));
    for (let r = 0; r < opts.runs; r++) out.push({ minutes, success: rand() < p, cluster: `t${t}`, family: `f${t % (opts.families ?? opts.tasks)}` });
  }
  return out;
}

describe("fitLogistic", () => {
  it("recovers known parameters from a large synthetic sample", () => {
    const rand = mulberry32(11);
    const a = 6;
    const b = -1;
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      const xi = rand() * 12; // log2 minutes in [0, 12]
      x.push(xi);
      y.push(rand() < sig(a + b * xi) ? 1 : 0);
    }
    const fit = fitLogistic(x, y, new Array(x.length).fill(1));
    expect(fit.converged).toBe(true);
    expect(fit.a).toBeCloseTo(a, 0);
    expect(Math.abs(fit.a - a)).toBeLessThan(0.15);
    expect(Math.abs(fit.b - b)).toBeLessThan(0.03);
  });

  it("uses weights (duplicating a point equals doubling its weight)", () => {
    const x = [0, 1, 2, 3, 3];
    const y = [1, 1, 0, 1, 0];
    const dup = fitLogistic([...x, 1], [...y, 1], [1, 1, 1, 1, 1, 1]);
    const w = fitLogistic(x, y, [1, 2, 1, 1, 1]);
    expect(w.a).toBeCloseTo(dup.a, 8);
    expect(w.b).toBeCloseTo(dup.b, 8);
  });

  it("stays finite under perfect separation thanks to the ridge", () => {
    const fit = fitLogistic([0, 1, 2, 3], [1, 1, 0, 0], [1, 1, 1, 1], 0.1);
    expect(Number.isFinite(fit.a)).toBe(true);
    expect(Number.isFinite(fit.b)).toBe(true);
    expect(fit.b).toBeLessThan(0);
  });

  it("returns an unconverged zero fit for a singular Hessian (no data, zero ridge)", () => {
    expect(fitLogistic([], [], [], 0)).toEqual({ a: 0, b: 0, converged: false });
  });
});

describe("weightsFor", () => {
  it("normalizes total weight to the number of tasks and gives each task equal mass within a family", () => {
    const pts: HorizonPoint[] = [
      { minutes: 1, success: true, cluster: "t1", family: "A" },
      { minutes: 1, success: false, cluster: "t1", family: "A" },
      { minutes: 2, success: true, cluster: "t2", family: "A" },
      { minutes: 4, success: true, cluster: "t3", family: "B" },
    ];
    const w = weightsFor(pts);
    expect(w.reduce((s, v) => s + v, 0)).toBeCloseTo(3, 12);
    expect(w[0]).toBeCloseTo(w[1]!, 12);
    const t1 = w[0]! + w[1]!;
    const t2 = w[2]!;
    const t3 = w[3]!;
    expect(t1).toBeCloseTo(t2, 12);
    // family A has 2 tasks -> each down-weighted by 1/sqrt(2) relative to the singleton family
    expect(t3 / t1).toBeCloseTo(Math.SQRT2, 12);
  });

  it("gives equal weights when every task is its own family with equal runs", () => {
    const pts: HorizonPoint[] = [0, 1, 2].flatMap((t) => [0, 1].map(() => ({ minutes: 1, success: true, cluster: `t${t}`, family: `f${t}` })));
    expect(weightsFor(pts)).toEqual(new Array(6).fill(0.5));
  });

  it("returns an empty array for no points", () => {
    expect(weightsFor([])).toEqual([]);
  });
});

describe("crossing", () => {
  it("solves for the crossing when b < 0", () => {
    const fit = { a: 6, b: -1 };
    expect(crossing(fit, 0.5, 0)).toBeCloseTo(6, 12);
    expect(crossing(fit, 0.8, 0)).toBeCloseTo(6 - logit(0.8), 12);
    expect(sig(fit.a + fit.b * crossing(fit, 0.8, 0))).toBeCloseTo(0.8, 12);
  });

  it("returns +Infinity when b >= 0 and the curve is above p at xRef", () => {
    expect(crossing({ a: 2, b: 0 }, 0.5, 3)).toBe(Infinity);
    expect(crossing({ a: 0, b: 0.5 }, 0.5, 1)).toBe(Infinity);
    expect(crossing({ a: 0, b: 0 }, 0.5, 1)).toBe(Infinity); // exactly at p counts as above
  });

  it("returns -Infinity when b >= 0 and the curve is below p at xRef", () => {
    expect(crossing({ a: -2, b: 0 }, 0.5, 3)).toBe(-Infinity);
    expect(crossing({ a: 1, b: 0 }, 0.8, 0)).toBe(-Infinity);
  });
});

describe("estimateHorizons", () => {
  const TRUE_H50 = 120;
  const SLOPE = 1;
  const TRUE_H80 = TRUE_H50 / 2 ** (logit(0.8) / SLOPE);
  const data = simulate({ h50: TRUE_H50, slope: SLOPE, tasks: 24, runs: 30, seed: 5, families: 6 });
  const fit = estimateHorizons(data, { bootstrap: 200, random: mulberry32(1) });

  it("recovers a known 50% horizon", () => {
    expect(fit.h50.unbounded).toBe(false);
    expect(fit.h50.identified).toBe(true);
    expect(fit.notes.join(" ")).not.toMatch(/identified/);
    expect(fit.h50.minutes!).toBeGreaterThan(TRUE_H50 / 1.3);
    expect(fit.h50.minutes!).toBeLessThan(TRUE_H50 * 1.3);
    expect(fit.slope).toBeLessThan(0);
    expect(Math.abs(fit.slope + SLOPE)).toBeLessThan(0.25);
    expect(fit.n).toBe(24 * 30);
  });

  it("recovers a known 80% horizon", () => {
    expect(fit.h80.minutes!).toBeGreaterThan(TRUE_H80 / 1.4);
    expect(fit.h80.minutes!).toBeLessThan(TRUE_H80 * 1.4);
    expect(fit.h80.minutes!).toBeLessThan(fit.h50.minutes!);
  });

  it("produces CIs that contain the truth and bracket the point estimate", () => {
    for (const [e, truth] of [
      [fit.h50, TRUE_H50],
      [fit.h80, TRUE_H80],
    ] as const) {
      expect(e.ciLow).not.toBeNull();
      expect(e.ciHigh).not.toBeNull();
      expect(e.ciLowUnbounded).toBe(false);
      expect(e.ciLow!).toBeLessThanOrEqual(truth);
      expect(e.ciHigh!).toBeGreaterThanOrEqual(truth);
      expect(e.ciLow!).toBeLessThanOrEqual(e.minutes!);
      expect(e.ciHigh!).toBeGreaterThanOrEqual(e.minutes!);
    }
  });

  it("predict() returns 0.5 at the fitted 50% horizon", () => {
    expect(predict(fit, fit.h50.minutes!)).toBeCloseTo(0.5, 9);
    expect(predict(fit, fit.h80.minutes!)).toBeCloseTo(0.8, 9);
  });

  it("all-success data gives an unbounded horizon with ciLowUnbounded", () => {
    const pts = simulate({ h50: 1e9, slope: 5, tasks: 10, runs: 4, seed: 1 }).map((p) => ({ ...p, success: true }));
    const f = estimateHorizons(pts, { bootstrap: 30, random: mulberry32(2) });
    for (const e of [f.h50, f.h80]) {
      expect(e).toEqual({ minutes: null, unbounded: true, identified: false, ciLow: null, ciLowUnbounded: true, ciHigh: null });
    }
    expect(f.notes.join(" ")).toMatch(/no horizon is identified/);
  });

  it("all-failure data gives a horizon of 0, not identified", () => {
    const pts = simulate({ h50: 1, slope: 1, tasks: 10, runs: 4, seed: 1 }).map((p) => ({ ...p, success: false }));
    const f = estimateHorizons(pts, { bootstrap: 30, random: mulberry32(2) });
    expect(f.slope).toBeGreaterThanOrEqual(MIN_IDENTIFYING_SLOPE); // ridge keeps the slope near 0
    for (const e of [f.h50, f.h80]) {
      expect(e).toEqual({ minutes: 0, unbounded: false, identified: false, ciLow: 0, ciLowUnbounded: false, ciHigh: 0 });
    }
  });

  it("all-failure data with a non-negative fitted slope gives exactly 0", () => {
    // Symmetric log2(minutes) around 0 => the slope gradient is zero by symmetry, b stays >= 0.
    const pts: HorizonPoint[] = [0.5, 2].flatMap((m, i) => [0, 1, 2].map(() => ({ minutes: m, success: false, cluster: `t${i}`, family: `f${i}` })));
    const f = estimateHorizons(pts, { bootstrap: 10, random: mulberry32(2) });
    expect(f.h50.minutes).toBe(0);
    expect(f.h80.minutes).toBe(0);
  });

  it("drops non-positive and non-finite minutes with a note", () => {
    const good = simulate({ h50: 60, slope: 1, tasks: 8, runs: 5, seed: 9 });
    const bad: HorizonPoint[] = [
      { minutes: 0, success: true, cluster: "z0", family: "z" },
      { minutes: -5, success: true, cluster: "z1", family: "z" },
      { minutes: NaN, success: true, cluster: "z2", family: "z" },
      { minutes: Infinity, success: false, cluster: "z3", family: "z" },
    ];
    const f = estimateHorizons([...good, ...bad], { bootstrap: 20, random: mulberry32(3) });
    expect(f.n).toBe(good.length);
    expect(f.notes).toContain("4 point(s) with non-positive minutes dropped");
    const ref = estimateHorizons(good, { bootstrap: 20, random: mulberry32(3) });
    expect(f.h50).toEqual(ref.h50);
  });

  it("returns an empty fit with a 'no data' note when nothing is valid", () => {
    const f = estimateHorizons([], { bootstrap: 10 });
    expect(f.n).toBe(0);
    expect(f.intercept).toBeNaN();
    expect(f.h50).toEqual({ minutes: null, unbounded: false, identified: false, ciLow: null, ciLowUnbounded: false, ciHigh: null });
    expect(f.notes).toContain("no data");
  });

  it("bootstrap is deterministic with a seeded random, and depends on the seed", () => {
    const pts = simulate({ h50: 60, slope: 1, tasks: 12, runs: 6, seed: 4 });
    const a = estimateHorizons(pts, { bootstrap: 60, random: mulberry32(77) });
    const b = estimateHorizons(pts, { bootstrap: 60, random: mulberry32(77) });
    const c = estimateHorizons(pts, { bootstrap: 60, random: mulberry32(78) });
    expect(a).toEqual(b);
    expect(c.h50.minutes).toBe(a.h50.minutes); // the point estimate does not use the bootstrap
    expect([c.h50.ciLow, c.h50.ciHigh]).not.toEqual([a.h50.ciLow, a.h50.ciHigh]);
  });

  it("bootstrap: 0 gives null CI bounds", () => {
    const pts = simulate({ h50: 60, slope: 1, tasks: 8, runs: 4, seed: 4 });
    const f = estimateHorizons(pts, { bootstrap: 0 });
    expect(f.h50.minutes).not.toBeNull();
    expect(f.h50.ciLow).toBeNull();
    expect(f.h50.ciHigh).toBeNull();
    expect(f.h50.ciLowUnbounded).toBe(false);
  });

  it("notes extrapolation far beyond the task range", () => {
    // Tasks of 1, 2, 4 min with 90% / 85% / 80% success: the 50% crossing is far past 4 min.
    const pts: HorizonPoint[] = [
      [1, 18],
      [2, 17],
      [4, 16],
    ].flatMap(([m, k], t) => Array.from({ length: 20 }, (_, r) => ({ minutes: m!, success: r < k!, cluster: `t${t}`, family: `f${t}` })));
    const f = estimateHorizons(pts, { bootstrap: 0 });
    expect(f.slope).toBeLessThan(0);
    expect(f.h50.minutes!).toBeGreaterThan(16);
    expect(f.notes).toContain("50% horizon is extrapolated beyond the task range");
    expect(f.h50.identified).toBe(true);
  });

  it("a wider CI level gives a wider interval", () => {
    const pts2 = simulate({ h50: 60, slope: 1, tasks: 12, runs: 6, seed: 4 });
    const narrow = estimateHorizons(pts2, { bootstrap: 100, random: mulberry32(1), ciLevel: 0.5 });
    const wide = estimateHorizons(pts2, { bootstrap: 100, random: mulberry32(1), ciLevel: 0.95 });
    expect(wide.h50.ciLow!).toBeLessThanOrEqual(narrow.h50.ciLow!);
    expect(wide.h50.ciHigh!).toBeGreaterThanOrEqual(narrow.h50.ciHigh!);
  });
});

describe("crossing: identification and extrapolation clamp", () => {
  it("MIN_IDENTIFYING_SLOPE is -0.05; slopes at or above it are treated like flat curves", () => {
    expect(MIN_IDENTIFYING_SLOPE).toBe(-0.05);
    // b = -0.05 exactly is not identified: falls back to the above/below-p rule
    expect(crossing({ a: 1, b: -0.05 }, 0.5, 0)).toBe(Infinity);
    expect(crossing({ a: -1, b: -0.05 }, 0.5, 0)).toBe(-Infinity);
    // just below the threshold is identified
    expect(crossing({ a: 1, b: -0.0501 }, 0.5, 0)).toBeCloseTo(1 / 0.0501, 9);
  });

  it("without a range, any identified crossing is returned as-is", () => {
    expect(crossing({ a: 100, b: -1 }, 0.5, 0)).toBe(100);
    expect(crossing({ a: -100, b: -1 }, 0.5, 0)).toBe(-100);
  });

  it("clamps crossings more than 6 doublings outside the task range", () => {
    const range = { xMin: 1, xMax: 10 };
    expect(crossing({ a: 16, b: -1 }, 0.5, 5, range)).toBe(16); // exactly 6 doublings beyond: kept
    expect(crossing({ a: 16.01, b: -1 }, 0.5, 5, range)).toBe(Infinity);
    expect(crossing({ a: -5, b: -1 }, 0.5, 5, range)).toBe(-5); // exactly 6 below xMin: kept
    expect(crossing({ a: -5.01, b: -1 }, 0.5, 5, range)).toBe(-Infinity);
  });

  it("estimateHorizons reports a clamped crossing as unbounded (identified), and a near-range one as finite", () => {
    const mk = (ks: number[]) =>
      [1, 2, 4, 8].flatMap((m, t) => Array.from({ length: 200 }, (_, r) => ({ minutes: m, success: r < ks[t]!, cluster: `t${t}`, family: `f${t}` })));
    // range is log2 0..3; crossing at ~9.1 > 3 + 6 -> clamped to "beyond all tasks"
    const far = estimateHorizons(mk([199, 198, 196, 194]), { bootstrap: 0, ridge: 0 });
    expect(far.slope).toBeLessThan(MIN_IDENTIFYING_SLOPE);
    expect((0 - far.intercept) / far.slope).toBeGreaterThan(9);
    expect(far.h50).toMatchObject({ identified: true, unbounded: true, minutes: null });
    // crossing at ~8.4 (< 9): kept as an extrapolated finite estimate, with a note
    const near = estimateHorizons(mk([196, 192, 188, 184]), { bootstrap: 0, ridge: 0 });
    expect(near.h50.unbounded).toBe(false);
    expect(near.h50.minutes!).toBeCloseTo(2 ** ((0 - near.intercept) / near.slope), 6);
    expect(near.notes).toContain("50% horizon is extrapolated beyond the task range");
  });
});

describe("hierarchicalResample", () => {
  const pts: HorizonPoint[] = [
    ...[0, 1, 2].map((r) => ({ minutes: 1, success: r === 0, cluster: "a1", family: "A" })),
    ...[0, 1].map((r) => ({ minutes: 2, success: r === 0, cluster: "a2", family: "A" })),
    ...[0, 1, 2, 3].map((r) => ({ minutes: 4, success: r < 2, cluster: "b1", family: "B" })),
  ];

  it("draws one family per family, its task count of tasks, and each task's run count of runs", () => {
    for (let seed = 0; seed < 50; seed++) {
      const out = hierarchicalResample(pts, mulberry32(seed));
      const fams = new Set(out.map((p) => p.family));
      expect(fams.size).toBe(2);
      // Each output task is a full copy-size of its source task.
      const byCluster = new Map<string, HorizonPoint[]>();
      for (const p of out) byCluster.set(p.cluster, [...(byCluster.get(p.cluster) ?? []), p]);
      for (const [cluster, runs] of byCluster) {
        const src = cluster.split("#")[0]!;
        expect(runs).toHaveLength(pts.filter((p) => p.cluster === src).length);
        // runs are drawn from the source task only
        for (const r of runs) expect(r.minutes).toBe(pts.find((p) => p.cluster === src)!.minutes);
      }
      // total tasks = sum over drawn families of that family's task count
      const drawnFams = [...fams].map((f) => f.split("#")[0]!);
      const expectTasks = drawnFams.reduce((s, f) => s + (f === "A" ? 2 : 1), 0);
      expect(byCluster.size).toBe(expectTasks);
    }
  });

  it("relabels clusters and families so duplicates count as distinct", () => {
    const out = hierarchicalResample(pts, () => 0); // always pick the first family/task/run
    expect(out.every((p) => p.family.startsWith("A#"))).toBe(true);
    expect(new Set(out.map((p) => p.family))).toEqual(new Set(["A#0", "A#1"]));
    expect(new Set(out.map((p) => p.cluster))).toEqual(new Set(["a1#0.0", "a1#0.1", "a1#1.0", "a1#1.1"]));
    expect(out).toHaveLength(12);
    expect(out.every((p) => p.success)).toBe(true); // run 0 of a1 is the success
  });

  it("is deterministic for a seeded random and returns [] for no points", () => {
    expect(hierarchicalResample(pts, mulberry32(9))).toEqual(hierarchicalResample(pts, mulberry32(9)));
    expect(hierarchicalResample([], mulberry32(1))).toEqual([]);
  });
});
