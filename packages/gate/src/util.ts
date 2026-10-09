import { createHash, createHmac } from "node:crypto";

/** Mulberry32: small, fast, seedable PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministically derives a 32-bit seed from a base seed and labels. */
export function deriveSeed(base: number, ...labels: (string | number)[]): number {
  const h = createHash("sha256").update(String(base));
  for (const l of labels) h.update("\u0000").update(String(l));
  return h.digest().readUInt32LE(0);
}

/** JSON with object keys sorted recursively, so equal values hash equally. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value), jsonReplacer);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    // Null prototype so a "__proto__" key is kept as data, not dropped.
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}

/** JSON replacer that keeps non-finite numbers distinguishable from null. */
export function jsonReplacer(_key: string, v: unknown): unknown {
  if (typeof v === "number" && !Number.isFinite(v)) return Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity";
  return v;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function hmacSha256(key: string, s: string): string {
  return createHmac("sha256", key).update(s).digest("hex");
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  // Guard against Infinity - Infinity = NaN when bounds are unbounded.
  if (a === b || pos === lo) return a;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return pos - lo < 0.5 ? a : b;
  return a + (b - a) * (pos - lo);
}

export function formatMinutes(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return "n/a";
  if (m < 1) return `${Math.round(m * 60)}s`;
  if (m < 60) return `${m.toFixed(m < 10 ? 1 : 0)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
