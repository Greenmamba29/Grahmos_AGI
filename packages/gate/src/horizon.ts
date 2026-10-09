import type { HorizonEstimate, HorizonFit } from "./types.js";
import { quantile } from "./util.js";

/**
 * Time-horizon estimation in the style of METR (Kwa et al., 2025):
 * fit P(success) = sigmoid(a + b * log2(humanMinutes)) and solve for the
 * task length at which the curve crosses 50% and 80%.
 *
 * Uncertainty comes from a hierarchical bootstrap that resamples families,
 * then tasks within each family, then runs within each task.
 *
 * Calibration: measured by independent simulation on the example suite,
 * these intervals over-cover at 8+ repeats per task (95–99% for nominal 95%)
 * and under-cover at 1 repeat (77–88%). Gates therefore never rely on the
 * fitted interval alone; see scoring.ts.
 */

export interface HorizonPoint {
  /** Human time for the task, in minutes (> 0). */
  minutes: number;
  success: boolean;
  /** Task id. */
  cluster: string;
  /** Family id (tasks in large families are down-weighted). */
  family: string;
}

export interface HorizonOptions {
  bootstrap?: number;
  /** Seeded random source for the bootstrap. */
  random?: () => number;
  /** Ridge penalty on the slope (stabilizes fits under separation). */
  ridge?: number;
  ciLevel?: number;
}

/** Slopes flatter than this (per doubling, on the logit scale) do not identify a horizon. */
export const MIN_IDENTIFYING_SLOPE = -0.05;
/** Crossings more than this many doublings outside the task range are reported as beyond / below all tasks. */
const MAX_EXTRAPOLATION_DOUBLINGS = 6;

const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
export const logit = (p: number): number => Math.log(p / (1 - p));

export interface LogisticFit {
  a: number;
  b: number;
  converged: boolean;
}

/** Weighted logistic regression with one feature, fitted by Newton/IRLS. */
export function fitLogistic(x: number[], y: number[], w: number[], ridge = 0.1): LogisticFit {
  let a = 0;
  let b = 0;
  const ridgeA = 1e-4;
  for (let iter = 0; iter < 100; iter++) {
    let g0 = -ridgeA * a;
    let g1 = -ridge * b;
    let h00 = ridgeA;
    let h01 = 0;
    let h11 = ridge;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i]!;
      const p = sigmoid(a + b * xi);
      const wi = w[i]!;
      const r = wi * (y[i]! - p);
      g0 += r;
      g1 += r * xi;
      const v = wi * p * (1 - p);
      h00 += v;
      h01 += v * xi;
      h11 += v * xi * xi;
    }
    const det = h00 * h11 - h01 * h01;
    if (!(Math.abs(det) > 1e-12)) return { a, b, converged: false };
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a += da;
    b += db;
    if (Math.abs(da) < 1e-10 && Math.abs(db) < 1e-10) return { a, b, converged: true };
  }
  return { a, b, converged: false };
}

/**
 * log2(minutes) at which the fitted curve equals p.
 * Returns +Infinity ("beyond every task") or -Infinity ("below every task")
 * when the crossing is far outside [xMin, xMax] or the slope does not identify it.
 */
export function crossing(fit: { a: number; b: number }, p: number, xRef: number, range?: { xMin: number; xMax: number }): number {
  if (fit.b < MIN_IDENTIFYING_SLOPE) {
    const x = (logit(p) - fit.a) / fit.b;
    if (range) {
      if (x > range.xMax + MAX_EXTRAPOLATION_DOUBLINGS) return Infinity;
      if (x < range.xMin - MAX_EXTRAPOLATION_DOUBLINGS) return -Infinity;
    }
    return x;
  }
  return sigmoid(fit.a + fit.b * xRef) >= p ? Infinity : -Infinity;
}

/** Per-point weights: 1/(runs of that task) × 1/sqrt(tasks in family), normalized to the task count. */
export function weightsFor(points: HorizonPoint[]): number[] {
  const runsPerTask = new Map<string, number>();
  const tasksPerFamily = new Map<string, Set<string>>();
  for (const p of points) {
    runsPerTask.set(p.cluster, (runsPerTask.get(p.cluster) ?? 0) + 1);
    if (!tasksPerFamily.has(p.family)) tasksPerFamily.set(p.family, new Set());
    tasksPerFamily.get(p.family)!.add(p.cluster);
  }
  const raw = points.map((p) => 1 / runsPerTask.get(p.cluster)! / Math.sqrt(tasksPerFamily.get(p.family)!.size));
  const total = raw.reduce((s, v) => s + v, 0);
  const nTasks = runsPerTask.size;
  return raw.map((v) => (total > 0 ? (v * nTasks) / total : 0));
}

function fitPoints(points: HorizonPoint[], ridge: number): LogisticFit {
  const x = points.map((p) => Math.log2(p.minutes));
  const y = points.map((p) => (p.success ? 1 : 0));
  return fitLogistic(x, y, weightsFor(points), ridge);
}

function toMinutes(log2m: number): number | null {
  if (log2m === Infinity) return null;
  if (log2m === -Infinity) return 0;
  return 2 ** log2m;
}

/** One hierarchical bootstrap sample: families, then tasks within family, then runs within task. */
export function hierarchicalResample(points: HorizonPoint[], rand: () => number): HorizonPoint[] {
  const fams = new Map<string, Map<string, HorizonPoint[]>>();
  for (const p of points) {
    if (!fams.has(p.family)) fams.set(p.family, new Map());
    const tasks = fams.get(p.family)!;
    if (!tasks.has(p.cluster)) tasks.set(p.cluster, []);
    tasks.get(p.cluster)!.push(p);
  }
  const famIds = [...fams.keys()];
  const out: HorizonPoint[] = [];
  for (let f = 0; f < famIds.length; f++) {
    const fam = famIds[Math.floor(rand() * famIds.length)]!;
    const tasks = fams.get(fam)!;
    const taskIds = [...tasks.keys()];
    for (let t = 0; t < taskIds.length; t++) {
      const tid = taskIds[Math.floor(rand() * taskIds.length)]!;
      const runs = tasks.get(tid)!;
      // Relabel so duplicates count as distinct tasks/families for weighting.
      const cluster = `${tid}#${f}.${t}`;
      const family = `${fam}#${f}`;
      for (let r = 0; r < runs.length; r++) {
        const run = runs[Math.floor(rand() * runs.length)]!;
        out.push({ ...run, cluster, family });
      }
    }
  }
  return out;
}

export function estimateHorizons(points: HorizonPoint[], opts: HorizonOptions = {}): HorizonFit {
  const notes: string[] = [];
  const ridge = opts.ridge ?? 0.1;
  const B = opts.bootstrap ?? 500;
  const level = opts.ciLevel ?? 0.95;
  const rand = opts.random ?? Math.random;

  const valid = points.filter((p) => p.minutes > 0 && Number.isFinite(p.minutes));
  if (valid.length < points.length) notes.push(`${points.length - valid.length} point(s) with non-positive minutes dropped`);
  const empty: HorizonEstimate = { minutes: null, unbounded: false, identified: false, ciLow: null, ciLowUnbounded: false, ciHigh: null };
  if (valid.length === 0) return { intercept: NaN, slope: NaN, n: 0, h50: empty, h80: empty, notes: [...notes, "no data"] };

  const xs = valid.map((p) => Math.log2(p.minutes));
  const xRef = xs.reduce((s, v) => s + v, 0) / xs.length;
  const range = { xMin: Math.min(...xs), xMax: Math.max(...xs) };

  const fit = fitPoints(valid, ridge);
  if (!fit.converged) notes.push("logistic fit did not fully converge");
  const identified = fit.b < MIN_IDENTIFYING_SLOPE;
  if (!identified) notes.push("success does not fall with task length (slope ≥ −0.05): no horizon is identified, so horizon gates cannot pass on this subset");

  const boot50: number[] = [];
  const boot80: number[] = [];
  for (let i = 0; i < B; i++) {
    const f = fitPoints(hierarchicalResample(valid, rand), ridge);
    boot50.push(crossing(f, 0.5, xRef, range));
    boot80.push(crossing(f, 0.8, xRef, range));
  }

  const alpha = (1 - level) / 2;
  const estimate = (p: number, boot: number[]): HorizonEstimate => {
    const x = crossing(fit, p, xRef, range);
    const sorted = [...boot].sort((u, v) => u - v);
    const lo = B > 0 ? quantile(sorted, alpha) : NaN;
    const hi = B > 0 ? quantile(sorted, 1 - alpha) : NaN;
    if (Number.isFinite(x) && (x > range.xMax + 1 || x < range.xMin - 1)) {
      notes.push(`${Math.round(p * 100)}% horizon is extrapolated beyond the task range`);
    }
    return {
      minutes: toMinutes(x),
      unbounded: x === Infinity,
      identified,
      ciLow: Number.isNaN(lo) ? null : toMinutes(lo),
      ciLowUnbounded: lo === Infinity,
      ciHigh: Number.isNaN(hi) ? null : toMinutes(hi),
    };
  };

  return { intercept: fit.a, slope: fit.b, n: valid.length, h50: estimate(0.5, boot50), h80: estimate(0.8, boot80), notes };
}

/** Fitted success probability at a given task length. */
export function predict(fit: { intercept: number; slope: number }, minutes: number): number {
  return sigmoid(fit.intercept + fit.slope * Math.log2(minutes));
}
