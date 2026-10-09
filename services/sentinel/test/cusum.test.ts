import { describe, expect, it } from "vitest";
import { averageRunLength, Cusum, findRecoveryGap, llr, mleChangePoint, shiftedRate, thresholdForARL0 } from "../src/cusum.js";
import { bernoulli, repeat } from "./helpers.js";

describe("llr / shiftedRate", () => {
  it("has the right signs and values", () => {
    expect(llr(1, 0.05, 0.15)).toBeCloseTo(Math.log(3), 12);
    expect(llr(0, 0.05, 0.15)).toBeCloseTo(Math.log(0.85 / 0.95), 12);
    expect(llr(1, 0.05, 0.15)).toBeGreaterThan(0);
    expect(llr(0, 0.05, 0.15)).toBeLessThan(0);
    // Mirrored for the recovery chart.
    expect(llr(1, 0.15, 0.05)).toBeLessThan(0);
    expect(llr(0, 0.15, 0.05)).toBeGreaterThan(0);
  });

  it("shiftedRate doubles or adds 10 points, capped at 0.95", () => {
    expect(shiftedRate(0.02)).toBeCloseTo(0.12);
    expect(shiftedRate(0.2)).toBeCloseTo(0.4);
    expect(shiftedRate(0.6)).toBe(0.95);
    expect(shiftedRate(0.1, 3, 0.05)).toBeCloseTo(0.3);
  });
});

describe("Cusum", () => {
  it("rejects invalid rates", () => {
    expect(() => new Cusum(0, 0.1, 5)).toThrow(RangeError);
    expect(() => new Cusum(0.1, 1, 5)).toThrow(RangeError);
    expect(() => new Cusum(0.1, 0.1, 5)).toThrow(RangeError);
  });

  it("clamps at zero and tracks the index after the last zero", () => {
    const c = new Cusum(0.05, 0.15, 5);
    expect(c.update(0)).toBe(false);
    expect(c.value).toBe(0);
    expect(c.changeIndex).toBe(1);
    c.update(0);
    expect(c.changeIndex).toBe(2);
    c.update(1);
    expect(c.value).toBeCloseTo(Math.log(3));
    expect(c.changeIndex).toBe(2);
    c.update(0);
    expect(c.value).toBeCloseTo(Math.log(3) + Math.log(0.85 / 0.95));
    expect(c.changeIndex).toBe(2);
    expect(c.count).toBe(4);
  });

  it("signals once the statistic exceeds h", () => {
    const c = new Cusum(0.05, 0.15, 2);
    expect(c.update(1)).toBe(false); // 1.10
    expect(c.update(1)).toBe(true); // 2.20 > 2
    expect(c.value).toBeGreaterThan(2);
  });

  it("updateLLR adds a precomputed ratio", () => {
    const c = new Cusum(0.05, 0.15, 2);
    expect(c.updateLLR(1.5)).toBe(false);
    expect(c.updateLLR(1)).toBe(true);
    expect(c.updateLLR(-10)).toBe(false);
    expect(c.value).toBe(0);
    expect(c.changeIndex).toBe(3);
  });

  it("reset clears the statistic and sets the change index", () => {
    const c = new Cusum(0.05, 0.15, 2);
    c.update(1);
    c.update(1);
    c.reset();
    expect(c.value).toBe(0);
    expect(c.changeIndex).toBe(2);
    c.reset(10);
    expect(c.changeIndex).toBe(10);
    expect(c.count).toBe(2);
  });
});

describe("averageRunLength / thresholdForARL0", () => {
  it("ARL0 is much larger than ARL1 for sensible parameters", () => {
    const p = { p0: 0.05, p1: 0.15, h: 4 };
    const arl0 = averageRunLength(p, 0.05, 300, 50_000, 3);
    const arl1 = averageRunLength(p, 0.15, 300, 50_000, 3);
    expect(arl0.censored).toBe(0);
    expect(arl1.mean).toBeGreaterThan(5);
    expect(arl1.mean).toBeLessThan(80);
    expect(arl0.mean).toBeGreaterThan(8 * arl1.mean);
  });

  it("is deterministic for a seed and censors at maxN", () => {
    const p = { p0: 0.05, p1: 0.15, h: 4 };
    expect(averageRunLength(p, 0.05, 50, 10_000, 9)).toEqual(averageRunLength(p, 0.05, 50, 10_000, 9));
    const c = averageRunLength({ p0: 0.05, p1: 0.15, h: 50 }, 0.05, 10, 20, 1);
    expect(c).toEqual({ mean: 20, censored: 10 });
  });

  it("larger h means longer ARL0", () => {
    const a = averageRunLength({ p0: 0.05, p1: 0.15, h: 2 }, 0.05, 200, 50_000, 4).mean;
    const b = averageRunLength({ p0: 0.05, p1: 0.15, h: 4 }, 0.05, 200, 50_000, 4).mean;
    expect(b).toBeGreaterThan(a);
  });

  it("thresholdForARL0 is monotone in the target and reaches it", () => {
    const targets = [20, 80, 300];
    const hs = targets.map((t) => thresholdForARL0(0.05, 0.15, t, 200));
    expect(hs[0]!).toBeLessThanOrEqual(hs[1]!);
    expect(hs[1]!).toBeLessThanOrEqual(hs[2]!);
    expect(hs[0]!).toBeLessThan(hs[2]!);
    for (const h of hs) expect((h * 4) % 1).toBe(0); // 0.25 steps
    expect(averageRunLength({ p0: 0.05, p1: 0.15, h: hs[2]! }, 0.05, 400, 50_000, 11).mean).toBeGreaterThan(300 * 0.7);
  });
});

describe("mleChangePoint", () => {
  it("finds a planted change point within tolerance", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const xs = bernoulli(400, (i) => (i < 200 ? 0.05 : 0.6), seed);
      expect(Math.abs(mleChangePoint(xs, 0, 399)! - 200)).toBeLessThanOrEqual(10);
      expect(Math.abs(mleChangePoint(xs, 0, 399, "up", 5)! - 200)).toBeLessThanOrEqual(10);
    }
  });

  it("finds a downward change (episode end) too", () => {
    const xs = bernoulli(300, (i) => (i < 120 ? 0.6 : 0.03), 8);
    expect(Math.abs(mleChangePoint(xs, 0, 299, "down", 5)! - 120)).toBeLessThanOrEqual(10);
  });

  it("direction picks the right edge of a quiet → bad → quiet window", () => {
    const xs: (0 | 1)[] = [...repeat(0, 50), ...repeat(1, 50), ...repeat(0, 50)];
    expect(mleChangePoint(xs, 0, 149, "up")).toBe(50);
    expect(mleChangePoint(xs, 0, 149, "down")).toBe(100);
    expect(mleChangePoint(xs, 20, 120)).toBe(50);
    expect(mleChangePoint(xs, 60, 149)).toBe(100);
  });

  it("returns undefined with a direction when no such split exists, lo+1 without one", () => {
    expect(mleChangePoint(repeat(0, 30), 0, 29, "up")).toBeUndefined();
    expect(mleChangePoint(repeat(1, 30), 0, 29, "down")).toBeUndefined();
    expect(mleChangePoint([...repeat(1, 10), ...repeat(0, 10)], 0, 19, "up")).toBeUndefined();
    const k = mleChangePoint(repeat(0, 10), 0, 9);
    expect(k).toBe(1);
  });

  it("minSeg keeps a stray edge observation from being reported as a change", () => {
    const xs: (0 | 1)[] = [...repeat(0, 40), 1];
    expect(mleChangePoint(xs, 0, 40, "up", 1)).toBe(40);
    // With minSeg 5 the right segment must hold at least 5 observations.
    expect(mleChangePoint(xs, 0, 40, "up", 5)).toBe(36);
    expect(mleChangePoint([0, 0, 1], 0, 2, "up", 2)).toBeUndefined();
    const ys: (0 | 1)[] = [...repeat(0, 40), ...repeat(1, 8)];
    const k = mleChangePoint(ys, 0, 47, "up", 5)!;
    expect(k).toBeGreaterThanOrEqual(5);
    expect(k).toBeLessThanOrEqual(43);
  });
});

describe("findRecoveryGap", () => {
  const opts = { maxGapRate: 0.1, minGap: 25, minLR: 20 };

  it("finds a planted gap between two elevated segments", () => {
    const xs = bernoulli(160, (i) => (i < 50 ? 0.7 : i < 100 ? 0.0 : 0.7), 3);
    const g = findRecoveryGap(xs, 0, 160, opts);
    expect(g).toBeDefined();
    expect(Math.abs(g!.a - 50)).toBeLessThanOrEqual(5);
    expect(Math.abs(g!.b - 100)).toBeLessThanOrEqual(5);
    expect(g!.lr).toBeGreaterThanOrEqual(20);
  });

  it("works on an offset window", () => {
    const xs: (0 | 1)[] = [...repeat(0, 100), ...bernoulli(160, (i) => (i < 50 ? 0.7 : i < 100 ? 0 : 0.7), 3)];
    const g = findRecoveryGap(xs, 100, 260, opts);
    expect(g).toBeDefined();
    expect(Math.abs(g!.a - 150)).toBeLessThanOrEqual(5);
    expect(Math.abs(g!.b - 200)).toBeLessThanOrEqual(5);
  });

  it("returns undefined for a homogeneous elevated segment", () => {
    expect(findRecoveryGap(bernoulli(160, () => 0.6, 4), 0, 160, opts)).toBeUndefined();
  });

  it("returns undefined when the gap is shorter than minGap", () => {
    const xs: (0 | 1)[] = [...repeat(1, 40), ...repeat(0, 10), ...repeat(1, 40)];
    expect(findRecoveryGap(xs, 0, xs.length, opts)).toBeUndefined();
  });

  it("returns undefined for windows too short to hold a gap", () => {
    expect(findRecoveryGap(repeat(1, 30), 0, 30, opts)).toBeUndefined();
  });
});
