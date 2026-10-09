import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJSON, deriveSeed, formatMinutes, hmacSha256, mulberry32, quantile, sha256 } from "../src/util.js";

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const sa = Array.from({ length: 50 }, () => a());
    const sb = Array.from({ length: 50 }, () => b());
    expect(sa).toEqual(sb);
  });

  it("produces different streams for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(Array.from({ length: 5 }, () => a())).not.toEqual(Array.from({ length: 5 }, () => b()));
  });

  it("returns floats in [0, 1) with a mean near 0.5", () => {
    const r = mulberry32(123);
    let sum = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / N).toBeGreaterThan(0.49);
    expect(sum / N).toBeLessThan(0.51);
  });

  it("coerces the seed to uint32 (seed and seed + 2^32 give the same stream)", () => {
    const a = mulberry32(7);
    const b = mulberry32(7 + 2 ** 32);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("deriveSeed", () => {
  it("is stable across calls and returns a uint32", () => {
    const s = deriveSeed(1, "agent", "task", 0);
    expect(deriveSeed(1, "agent", "task", 0)).toBe(s);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(2 ** 32);
  });

  it("changes with base, labels, and label order", () => {
    const s = deriveSeed(1, "a", "b");
    expect(deriveSeed(2, "a", "b")).not.toBe(s);
    expect(deriveSeed(1, "b", "a")).not.toBe(s);
    expect(deriveSeed(1, "a", "c")).not.toBe(s);
  });

  it("separates labels so ('a','b') differs from ('ab')", () => {
    expect(deriveSeed(0, "a", "b")).not.toBe(deriveSeed(0, "ab"));
  });

  it("treats numeric and string labels with the same text identically", () => {
    expect(deriveSeed(0, 3)).toBe(deriveSeed(0, "3"));
  });
});

describe("canonicalJSON", () => {
  it("is independent of key insertion order, recursively", () => {
    const x = { b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } };
    const y = { a: { c: 3, d: [{ y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJSON(x)).toBe(canonicalJSON(y));
    expect(canonicalJSON(x)).toBe('{"a":{"c":3,"d":[{"y":2,"z":1}]},"b":1}');
  });

  it("preserves array order, including nested arrays", () => {
    expect(canonicalJSON([1, 2])).not.toBe(canonicalJSON([2, 1]));
    expect(canonicalJSON({ m: [[{ b: 1, a: 2 }], [3, [4, 5]]] })).toBe('{"m":[[{"a":2,"b":1}],[3,[4,5]]]}');
  });

  it("drops undefined-valued keys and keeps null", () => {
    expect(canonicalJSON({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("keeps __proto__ keys as data", () => {
    expect(canonicalJSON(JSON.parse('{"b":1,"__proto__":{"z":1,"y":2}}'))).toBe('{"__proto__":{"y":2,"z":1},"b":1}');
  });

  it("encodes non-finite numbers as strings", () => {
    expect(canonicalJSON([Infinity, -Infinity, NaN, 1])).toBe('["Infinity","-Infinity","NaN",1]');
    expect(canonicalJSON({ x: Infinity })).not.toBe(canonicalJSON({ x: null }));
  });

  it("handles primitives", () => {
    expect(canonicalJSON("s")).toBe('"s"');
    expect(canonicalJSON(3)).toBe("3");
    expect(canonicalJSON(null)).toBe("null");
  });
});

describe("hashes", () => {
  it("sha256 matches a known vector", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("hmacSha256 matches node:crypto and depends on the key", () => {
    expect(hmacSha256("k", "m")).toBe(createHmac("sha256", "k").update("m").digest("hex"));
    expect(hmacSha256("k1", "m")).not.toBe(hmacSha256("k2", "m"));
  });
});

describe("quantile", () => {
  it("returns NaN for an empty array", () => {
    expect(quantile([], 0.5)).toBeNaN();
  });
  it("returns the only element of a single-element array", () => {
    expect(quantile([7], 0)).toBe(7);
    expect(quantile([7], 0.5)).toBe(7);
    expect(quantile([7], 1)).toBe(7);
  });
  it("interpolates linearly between order statistics", () => {
    const s = [1, 2, 3, 4];
    expect(quantile(s, 0)).toBe(1);
    expect(quantile(s, 1)).toBe(4);
    expect(quantile(s, 0.5)).toBe(2.5);
    expect(quantile(s, 1 / 3)).toBeCloseTo(2, 12);
  });
  it("never returns NaN when bounds are Infinity / -Infinity", () => {
    expect(quantile([1, Infinity], 0.4)).toBe(1); // nearer the finite bound
    expect(quantile([1, Infinity], 0.5)).toBe(Infinity); // ties go to the upper bound
    expect(quantile([Infinity, Infinity], 0.3)).toBe(Infinity);
    expect(quantile([-Infinity, -Infinity, 3], 0.25)).toBe(-Infinity);
    expect(quantile([-Infinity, 3], 0.75)).toBe(3);
    expect(quantile([-Infinity, Infinity], 0.5)).toBe(Infinity);
    expect(quantile([-Infinity, 0, Infinity], 0.5)).toBe(0);
  });
});

describe("formatMinutes", () => {
  it.each([
    [0, "0s"],
    [0.5, "30s"],
    [5, "5.0m"],
    [30, "30m"],
    [60, "1.0h"],
    [480, "8.0h"],
    [600, "10h"],
    [2880, "2.0d"],
    [60 * 24 * 7, "7.0d"],
  ])("formats %s minutes as %s", (m, s) => {
    expect(formatMinutes(m)).toBe(s);
  });

  it("rounds 59.9 minutes to '60m' (rounding happens after the unit is chosen)", () => {
    expect(formatMinutes(59.9)).toBe("60m");
  });

  it("returns n/a for null and non-finite values", () => {
    expect(formatMinutes(null)).toBe("n/a");
    expect(formatMinutes(Infinity)).toBe("n/a");
    expect(formatMinutes(NaN)).toBe("n/a");
  });
});
