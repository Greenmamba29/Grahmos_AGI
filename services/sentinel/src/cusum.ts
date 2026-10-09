import { mulberry32 } from "@grahmos/gate";

/**
 * Bernoulli CUSUM (Page, 1954; Reynolds & Stoumbos, 1999).
 *
 * Upward chart (detects the START of an episode), testing p0 → p1:
 *   S⁺ₙ = max(0, S⁺ₙ₋₁ + LLR(xₙ)),  LLR(1) = ln(p1/p0),  LLR(0) = ln((1−p1)/(1−p0))
 * Downward chart (detects the END), run only during an episode, tests p1 → p0.
 *
 * The online "first observation after the chart was last at zero" is only a
 * rough change-point estimate; StreamMonitor refines onset and end with a
 * directional two-segment maximum-likelihood fit (mleChangePoint).
 *
 * h trades detection delay against false alarms; averageRunLength() measures
 * both by simulation so the threshold is chosen from numbers, not guessed.
 */

export interface CusumParams {
  p0: number;
  p1: number;
  h: number;
}

export function llr(x: 0 | 1, from: number, to: number): number {
  return x === 1 ? Math.log(to / from) : Math.log((1 - to) / (1 - from));
}

/** Out-of-control rate for a baseline: double it, or add 10 points, whichever is larger (capped at 0.95). */
export function shiftedRate(p0: number, multiplier = 2, minDelta = 0.1): number {
  return Math.min(0.95, Math.max(p0 * multiplier, p0 + minDelta));
}

export class Cusum {
  value = 0;
  /** Number of updates after which the statistic was last at 0 (i.e. index of the first observation after it). */
  changeIndex = 0;
  private n = 0;

  constructor(
    private readonly from: number,
    private readonly to: number,
    readonly h: number,
  ) {
    if (!(from > 0 && from < 1 && to > 0 && to < 1 && from !== to)) throw new RangeError(`invalid CUSUM rates ${from} → ${to}`);
  }

  /** Adds one observation; returns true when the chart signals. */
  update(x: 0 | 1): boolean {
    return this.updateLLR(llr(x, this.from, this.to));
  }

  /** Adds a precomputed log-likelihood ratio (used by stratified streams). */
  updateLLR(v: number): boolean {
    const s = this.value + v;
    if (s <= 0) {
      this.value = 0;
      this.changeIndex = this.n + 1;
    } else this.value = s;
    this.n++;
    return this.value > this.h;
  }

  reset(atIndex = this.n): void {
    this.value = 0;
    this.changeIndex = atIndex;
  }

  get count(): number {
    return this.n;
  }
}

/**
 * Average run length by simulation: ARL0 (mean observations to a false alarm
 * when the true rate is p0) and ARL1 (mean delay to detection when the true
 * rate is p1). Censored at maxN.
 */
export function averageRunLength(p: CusumParams, trueRate: number, sims = 2000, maxN = 100_000, seed = 1): { mean: number; censored: number } {
  const r = mulberry32(seed);
  let total = 0;
  let censored = 0;
  for (let s = 0; s < sims; s++) {
    const c = new Cusum(p.p0, p.p1, p.h);
    let n = 0;
    while (n < maxN) {
      n++;
      if (c.update(r() < trueRate ? 1 : 0)) break;
    }
    if (n >= maxN) censored++;
    total += n;
  }
  return { mean: total / sims, censored };
}

/** Smallest threshold (0.25 steps) whose ARL0 reaches the target. */
export function thresholdForARL0(p0: number, p1: number, targetARL0: number, sims = 400): number {
  for (let h = 1; h <= 20; h += 0.25) {
    if (averageRunLength({ p0, p1, h }, p0, sims, targetARL0 * 10).mean >= targetARL0) return h;
  }
  return 20;
}

const segLL = (k: number, n: number) => (k === 0 || k === n || n === 0 ? 0 : k * Math.log(k / n) + (n - k) * Math.log(1 - k / n));

/**
 * Maximum-likelihood change point for a 0/1 sequence split into two segments
 * with their own rates: returns k in (lo, hi] maximizing
 * loglik(xs[lo..k)) + loglik(xs[k..hi]).
 * `direction` restricts the search to splits where the rate goes up (onset)
 * or down (end); without it a quiet → bad → quiet window can return the
 * wrong edge. With a direction, returns undefined when no such split exists.
 * `minSeg` keeps both segments at least that long, so one stray observation
 * at either edge cannot be reported as a change.
 */
export function mleChangePoint(xs: readonly (0 | 1)[], lo: number, hi: number, direction?: "up" | "down", minSeg = 1): number | undefined {
  const total = xs.slice(lo, hi + 1).reduce<number>((a, b) => a + b, 0);
  const N = hi - lo + 1;
  let best: number | undefined;
  let bestLL = -Infinity;
  let left = 0;
  for (let k = lo + 1; k <= hi; k++) {
    left += xs[k - 1]!;
    const nL = k - lo;
    const nR = N - nL;
    if (nL < minSeg || nR < minSeg) continue;
    const rL = left / nL;
    const rR = (total - left) / nR;
    if (direction === "up" && !(rR > rL)) continue;
    if (direction === "down" && !(rL > rR)) continue;
    const ll = segLL(left, nL) + segLL(total - left, nR);
    if (ll > bestLL + 1e-12) {
      bestLL = ll;
      best = k;
    }
  }
  return direction ? best : (best ?? lo + 1);
}

/**
 * Looks for a recovery gap inside an episode: a segment [a, b) whose rate is
 * at or below `maxGapRate`, flanked by elevated segments, such that the
 * three-segment fit beats the single-rate fit by likelihood ratio
 * 2·ΔLL ≥ `minLR`. Long episodes are scanned on a coarse grid (≤ ~600
 * candidate edges per side) so the cost stays bounded.
 */
export function findRecoveryGap(xs: readonly (0 | 1)[], lo: number, hi: number, opts: { maxGapRate: number; minGap: number; minLR: number }): { a: number; b: number; lr: number } | undefined {
  const n = hi - lo;
  if (n < opts.minGap + 6) return undefined;
  const cum = [0];
  for (let i = lo; i < hi; i++) cum.push(cum.at(-1)! + xs[i]!);
  const k = (a: number, b: number) => cum[b - lo]! - cum[a - lo]!;
  const ll1 = segLL(k(lo, hi), n);
  const step = Math.max(1, Math.ceil(n / 600));
  let best: { a: number; b: number; lr: number } | undefined;
  for (let a = lo + 3; a < hi - opts.minGap - 2; a += step) {
    for (let b = a + opts.minGap; b <= hi - 3; b += step) {
      const kg = k(a, b);
      if (kg / (b - a) > opts.maxGapRate) continue;
      const lr = 2 * (segLL(k(lo, a), a - lo) + segLL(kg, b - a) + segLL(k(b, hi), hi - b) - ll1);
      if (lr >= opts.minLR && (!best || lr > best.lr)) best = { a, b, lr };
    }
  }
  return best;
}
