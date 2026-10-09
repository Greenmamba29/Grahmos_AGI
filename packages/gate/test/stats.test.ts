import { describe, expect, it } from "vitest";
import { betaInc, betaInv, clopperPearson } from "../src/stats.js";

describe("betaInc / betaInv", () => {
  it("matches closed forms", () => {
    // I_x(1, 1) = x; I_x(a, 1) = x^a; I_x(1, b) = 1 - (1-x)^b
    for (const x of [0.1, 0.37, 0.5, 0.9]) {
      expect(betaInc(x, 1, 1)).toBeCloseTo(x, 12);
      expect(betaInc(x, 3, 1)).toBeCloseTo(x ** 3, 12);
      expect(betaInc(x, 1, 4)).toBeCloseTo(1 - (1 - x) ** 4, 12);
    }
    // I_0.5(2, 3) = 11/16
    expect(betaInc(0.5, 2, 3)).toBeCloseTo(11 / 16, 12);
    // symmetry: I_x(a, b) = 1 - I_{1-x}(b, a)
    expect(betaInc(0.3, 2.5, 7)).toBeCloseTo(1 - betaInc(0.7, 7, 2.5), 12);
  });

  it("clamps outside (0, 1)", () => {
    expect(betaInc(0, 2, 3)).toBe(0);
    expect(betaInc(-1, 2, 3)).toBe(0);
    expect(betaInc(1, 2, 3)).toBe(1);
    expect(betaInc(2, 2, 3)).toBe(1);
  });

  it("betaInv inverts betaInc", () => {
    for (const [p, a, b] of [
      [0.6875, 2, 3],
      [0.025, 7, 4],
      [0.975, 8, 3],
      [0.5, 30, 70],
    ] as const) {
      const x = betaInv(p, a, b);
      expect(betaInc(x, a, b)).toBeCloseTo(p, 9);
    }
    expect(betaInv(0.6875, 2, 3)).toBeCloseTo(0.5, 9);
  });
});

describe("clopperPearson", () => {
  it("7/10 matches the reference interval [0.3475, 0.9333]", () => {
    const b = clopperPearson(7, 10);
    expect(b.lower).toBeCloseTo(0.3475, 4);
    expect(b.upper).toBeCloseTo(0.9333, 4);
  });

  it("50/100 is symmetric around 0.5 and matches [0.3983, 0.6017]", () => {
    const b = clopperPearson(50, 100);
    expect(b.lower).toBeCloseTo(0.3983, 4);
    expect(b.upper).toBeCloseTo(0.6017, 4);
    expect(b.lower + b.upper).toBeCloseTo(1, 10);
  });

  it("all successes: lower = alpha^(1/n), upper = 1", () => {
    for (const n of [1, 16, 17, 100]) {
      const b = clopperPearson(n, n);
      expect(b.lower).toBeCloseTo(0.025 ** (1 / n), 9);
      expect(b.upper).toBe(1);
    }
    expect(clopperPearson(16, 16).lower).toBeLessThan(0.8); // 16/16 cannot certify 80%
    expect(clopperPearson(17, 17).lower).toBeGreaterThan(0.8); // 17/17 can
  });

  it("zero successes: lower = 0, upper = 1 - alpha^(1/n)", () => {
    for (const n of [1, 16, 183, 192]) {
      const b = clopperPearson(0, n);
      expect(b.lower).toBe(0);
      expect(b.upper).toBeCloseTo(1 - 0.025 ** (1 / n), 9);
    }
    expect(clopperPearson(0, 192).upper).toBeCloseTo(0.01903, 5);
    expect(clopperPearson(0, 182).upper).toBeGreaterThan(0.02);
    expect(clopperPearson(0, 183).upper).toBeLessThan(0.02); // matches the "≥ 183 runs" claim in scoring.ts
  });

  it("respects a custom alpha and is monotone", () => {
    const wide = clopperPearson(7, 10, 0.005);
    const narrow = clopperPearson(7, 10, 0.1);
    expect(wide.lower).toBeLessThan(narrow.lower);
    expect(wide.upper).toBeGreaterThan(narrow.upper);
    let prev = -1;
    for (let k = 0; k <= 20; k++) {
      const { lower, upper } = clopperPearson(k, 20);
      if (k > 0) expect(lower).toBeGreaterThan(prev);
      expect(lower).toBeLessThanOrEqual(k / 20);
      expect(upper).toBeGreaterThanOrEqual(k / 20);
      prev = lower;
    }
  });

  it("n = 0 gives the vacuous interval [0, 1]", () => {
    expect(clopperPearson(0, 0)).toEqual({ lower: 0, upper: 1 });
    expect(clopperPearson(5, -1)).toEqual({ lower: 0, upper: 1 });
  });

  it("throws RangeError for k out of range", () => {
    expect(() => clopperPearson(-1, 10)).toThrow(RangeError);
    expect(() => clopperPearson(11, 10)).toThrow(/k must be in \[0, n\], got k=11, n=10/);
  });
});
