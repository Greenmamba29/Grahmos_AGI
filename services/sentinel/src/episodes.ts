import { findRecoveryGap, mleChangePoint, shiftedRate } from "./cusum.js";
import type { Attribution, Episode, HostContext } from "./types.js";

/**
 * One monitored stream (e.g. "qwen3.6-27b|16k"): a CUSUM pair that opens an
 * episode when the hallucination rate rises and closes it when the rate
 * returns to baseline, with refined estimates of when each episode began and
 * ended.
 *
 * Streams are STRATIFIED: each observation carries a stratum (its context
 * band) and is tested against that stratum's own baseline, so a combined
 * stream over bands with different normal rates does not raise false alarms
 * just because consecutive probes come from different bands.
 *
 * Warmup is per stream: once the stream has `warmup` observations, every
 * stratum gets a baseline shrunk toward the stream's pooled rate
 * (p0 = (k + m·p̄) / (n + m)), so thin strata are usable early without
 * trusting a handful of observations.
 */

export interface MonitorConfig {
  /** Minimum observations on the stream before baselines are set… */
  warmup: number;
  /** …and minimum hallucinations seen (so low baselines are not guessed from zero events)… */
  warmupEvents: number;
  /** …unless this many observations have been seen. */
  maxWarmup: number;
  /** Fixed baseline rate; skips the warmup. */
  baseline?: number;
  /** Baselines above this are reported as a standing problem (a stream that is bad from the start). */
  maxBaseline: number;
  /** Decision threshold for detecting an episode. */
  h: number;
  /** Decision threshold for confirming recovery. */
  hRecovery: number;
  /** Out-of-control rate = max(p0 × multiplier, p0 + minDelta). */
  multiplier: number;
  minDelta: number;
  /** Observations before onset used as the comparison window for attribution. */
  attributionWindow: number;
  /** An alarm within this many observations of the last close reopens that episode. */
  reopenWithin: number;
  /** Split a closed episode at an interior recovery gap at least this long… */
  minGap: number;
  /** …when the three-segment fit beats one rate by this likelihood ratio (2·ΔLL). */
  gapLR: number;
  /** Observations kept in memory per stream (older ones are dropped; episodes are kept). */
  maxObservations: number;
  /** Pseudo-observations pulling each stratum's baseline toward the pooled rate. */
  shrink: number;
  /** Every stratum seen during warmup needs at least this many observations before baselines are set. */
  minStratum: number;
  /** How far back (observations) the onset search may look from the alarm. */
  onsetLookback: number;
  /** Minimum observations on each side of an estimated onset or end. */
  minSegment: number;
}

export const DEFAULT_MONITOR: MonitorConfig = {
  warmup: 100,
  warmupEvents: 5,
  maxWarmup: 1500,
  maxBaseline: 0.25,
  h: 5,
  hRecovery: 3,
  multiplier: 2,
  minDelta: 0.1,
  attributionWindow: 100,
  reopenWithin: 30,
  minGap: 25,
  gapLR: 20,
  maxObservations: 20_000,
  shrink: 10,
  minStratum: 60,
  onsetLookback: 400,
  minSegment: 5,
};

export interface Observation {
  seq: number;
  at: string;
  x: 0 | 1;
  probeId: string;
  host: HostContext;
  /** Baseline group (context band). Defaults to a single stratum. */
  stratum?: string;
  contextTokens?: number;
}

export interface MonitorEvent {
  type: "opened" | "closed" | "baseline_high";
  episode?: Episode;
  stratum?: string;
  baseline?: number;
}

const NUMERIC: (keyof HostContext)[] = ["kvPressure", "thermalDerate", "gpuTempC", "queueDepth"];
const CATEGORICAL: (keyof HostContext)[] = ["modelId", "checkpoint", "quantization"];
const round = (x: number) => Math.round(x * 1000) / 1000;
const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
const sd = (xs: number[], m: number) => Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, xs.length - 1));
const mode = (xs: string[]) => {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
};

/**
 * How host conditions during the episode differed from just before it.
 * Co-occurring conditions, not proven causes; ranked by effect size.
 */
export function attribute(before: Observation[], during: Observation[]): Attribution[] {
  const out: Attribution[] = [];
  const numeric = (factor: string, b: number[], d: number[]) => {
    if (b.length < 3 || d.length < 3) return;
    const mb = mean(b);
    const md = mean(d);
    const pooled = Math.sqrt((sd(b, mb) ** 2 + sd(d, md) ** 2) / 2);
    const effect = pooled > 1e-9 ? Math.abs(md - mb) / pooled : md !== mb ? 10 : 0;
    out.push({ factor, baseline: round(mb), inEpisode: round(md), effect: round(effect) });
  };
  const num = (os: Observation[], f: (o: Observation) => unknown) => os.map(f).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  for (const k of NUMERIC) numeric(k, num(before, (o) => o.host[k]), num(during, (o) => o.host[k]));
  for (const k of new Set(during.flatMap((o) => Object.keys(o.host.extra ?? {})))) numeric(`extra.${k}`, num(before, (o) => o.host.extra?.[k]), num(during, (o) => o.host.extra?.[k]));
  numeric("contextTokens", num(before, (o) => o.contextTokens), num(during, (o) => o.contextTokens));
  for (const k of CATEGORICAL) {
    const b = before.map((o) => o.host[k]).filter((v): v is string => typeof v === "string");
    const d = during.map((o) => o.host[k]).filter((v): v is string => typeof v === "string");
    if (!b.length || !d.length) continue;
    const mb = mode(b);
    const md = mode(d);
    if (mb !== md) out.push({ factor: k, baseline: mb, inEpisode: md, effect: 1 });
  }
  return out.sort((a, b) => b.effect - a.effect);
}

interface Stratum {
  /** Warmup observations and hallucinations the baseline was estimated from. */
  n: number;
  k: number;
  p0?: number;
  p1?: number;
}

interface Obs extends Observation {
  /** Counted by the charts (its stratum's baseline was set). */
  charted: boolean;
}

export class StreamMonitor {
  /** Observations in memory; obs[j] has absolute stream index base + j. */
  private obs: Obs[] = [];
  private base = 0;
  private readonly strata = new Map<string, Stratum>();
  private warmStart = 0;
  private wn = 0;
  private wk = 0;
  /** All warmup observations ever seen (restarts do not reset it). */
  private wTotal = 0;
  private reopenIdx?: number;
  private pooled?: number;
  private unstable = false;
  private up = 0;
  private upZero = 0;
  private down = 0;
  private downZero = 0;
  private open?: Episode;
  private counter = 0;
  private readonly onsetIdx = new Map<string, number>();
  private lastCloseIdx = -Infinity;
  private lastEndIdx = 0;
  private firstCharted?: number;
  readonly episodes: Episode[] = [];

  constructor(
    readonly stream: string,
    private readonly cfg: MonitorConfig = DEFAULT_MONITOR,
  ) {}

  private at(i: number): Obs {
    return this.obs[i - this.base]!;
  }
  private get end(): number {
    return this.base + this.obs.length;
  }

  get state(): "warmup" | "normal" | "episode" {
    if (this.open) return "episode";
    return this.pooled !== undefined ? "normal" : "warmup";
  }
  /** Baseline per stratum. */
  get baselines(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, s] of this.strata) if (s.p0 !== undefined) out[k] = round(s.p0);
    return out;
  }
  /** Strata whose warmup never stabilised (an episode during warmup that would not go away). */
  get unstableStrata(): string[] {
    return this.unstable ? [...this.strata.keys()] : [];
  }
  /** Observation-weighted baseline across strata (for display). */
  get baseline(): number | undefined {
    let n = 0;
    let w = 0;
    for (const s of this.strata.values()) if (s.p0 !== undefined) (w += s.p0 * s.n), (n += s.n);
    return n ? w / n : this.pooled;
  }
  get statistic(): number {
    return this.open ? this.down : this.up;
  }
  get count(): number {
    return this.end;
  }
  get observations(): readonly Observation[] {
    return this.obs;
  }
  get current(): Episode | undefined {
    return this.open ? structuredClone(this.open) : undefined;
  }
  recentRate(window = 50): number {
    const tail = this.obs.slice(-window);
    return tail.length ? tail.reduce((s, o) => s + o.x, 0) / tail.length : 0;
  }

  private warm(o: Obs): MonitorEvent[] {
    const key = o.stratum ?? "_";
    let st = this.strata.get(key);
    if (!st) {
      st = { n: 0, k: 0 };
      this.strata.set(key, st);
      if (this.cfg.baseline !== undefined) {
        this.pooled = this.cfg.baseline;
        this.setBaseline(st, this.cfg.baseline);
      } else if (this.pooled !== undefined) this.setBaseline(st, this.pooled); // stratum first seen after warmup
    }
    if (this.pooled !== undefined) return [];
    this.wn++;
    this.wk += o.x;
    this.wTotal++;
    st.n++;
    st.k += o.x;
    const capped = this.wTotal >= this.cfg.maxWarmup;
    if (!capped && (this.wn < this.cfg.warmup || this.wk < this.cfg.warmupEvents)) return [];
    if (!capped && [...this.strata.values()].some((x) => x.n < this.cfg.minStratum)) return [];
    // Stability check: compare the two halves of the warmup; if they differ
    // sharply (an episode during warmup), drop the first half and keep warming.
    const half = this.halves();
    if (half && Math.abs(half.z) > 3) {
      if (!capped) {
        this.warmStart = half.mid;
        this.wn = half.n2;
        this.wk = half.k2;
        for (const x of this.strata.values()) (x.n = 0), (x.k = 0);
        for (let j = Math.max(this.warmStart, this.base); j < this.end; j++) {
          const ob = this.at(j);
          const x = this.strata.get(ob.stratum ?? "_")!;
          x.n++;
          x.k += ob.x;
        }
        return [];
      }
      this.unstable = true;
    }
    this.pooled = (this.wk + 0.5) / (this.wn + 1);
    const counts = new Map<string, { n: number; k: number }>();
    for (let j = Math.max(this.warmStart, this.base); j < this.end; j++) {
      const x = this.at(j);
      const c = counts.get(x.stratum ?? "_") ?? { n: 0, k: 0 };
      c.n++;
      c.k += x.x;
      counts.set(x.stratum ?? "_", c);
    }
    const events: MonitorEvent[] = [];
    for (const [k, s] of this.strata) {
      const c = counts.get(k) ?? { n: 0, k: 0 };
      s.n = c.n;
      s.k = c.k;
      this.setBaseline(s, (c.k + this.cfg.shrink * this.pooled) / (c.n + this.cfg.shrink));
      if (s.p0! > this.cfg.maxBaseline) events.push({ type: "baseline_high", stratum: k, baseline: round(s.p0!) });
    }
    return events;
  }

  private halves(): { z: number; mid: number; n2: number; k2: number } | undefined {
    const xs: number[] = [];
    const idx: number[] = [];
    for (let i = Math.max(this.warmStart, this.base); i < this.end; i++) xs.push(this.at(i).x), idx.push(i);
    if (xs.length < 20) return undefined;
    const m = Math.floor(xs.length / 2);
    const k1 = xs.slice(0, m).reduce((a, b) => a + b, 0);
    const k2 = xs.slice(m).reduce((a, b) => a + b, 0);
    const n2 = xs.length - m;
    const p = (k1 + k2) / xs.length;
    const se = Math.sqrt(Math.max(p * (1 - p), 1e-6) * (1 / m + 1 / n2));
    return { z: (k1 / m - k2 / n2) / se, mid: idx[m]!, n2, k2 };
  }

  private setBaseline(s: Stratum, p0: number): void {
    s.p0 = Math.min(0.9, Math.max(0.002, p0));
    s.p1 = shiftedRate(s.p0, this.cfg.multiplier, this.cfg.minDelta);
  }

  private llr(o: Obs, dir: "up" | "down"): number {
    const s = this.strata.get(o.stratum ?? "_")!;
    const [from, to] = dir === "up" ? [s.p0!, s.p1!] : [s.p1!, s.p0!];
    return o.x === 1 ? Math.log(to / from) : Math.log((1 - to) / (1 - from));
  }

  /** Charted 0/1 values on [lo, hi] with their absolute indices. */
  private charted(lo: number, hi: number): { xs: (0 | 1)[]; idx: number[] } {
    const xs: (0 | 1)[] = [];
    const idx: number[] = [];
    for (let i = Math.max(lo, this.base); i <= hi && i < this.end; i++) {
      const o = this.at(i);
      if (o.charted) xs.push(o.x), idx.push(i);
    }
    return { xs, idx };
  }

  /** Directional MLE change point on [lo, hi] (absolute indices); `fallback` if none. */
  private refine(lo: number, hi: number, dir: "up" | "down", fallback: number): number {
    const { xs, idx } = this.charted(lo, hi);
    if (xs.length < 3) return fallback;
    const k = mleChangePoint(xs, 0, xs.length - 1, dir, this.cfg.minSegment);
    return k === undefined ? fallback : idx[k]!;
  }

  add(input: Observation): MonitorEvent[] {
    const o: Obs = { ...input, charted: false };
    this.obs.push(o);
    const i = this.end - 1;
    const events: MonitorEvent[] = this.warm(o);
    const s = this.strata.get(o.stratum ?? "_")!;
    if (s.p0 === undefined) return events;
    o.charted = true;

    if (this.firstCharted === undefined) {
      // Charting starts here: nothing before this point can be an onset.
      this.firstCharted = i;
      this.upZero = i;
      this.lastEndIdx = Math.max(this.lastEndIdx, i);
    }
    if (!this.open) {
      this.up = Math.max(0, this.up + this.llr(o, "up"));
      if (this.up === 0) this.upZero = i + 1;
      if (this.up > this.cfg.h) events.push(this.alarm(i));
    } else {
      this.down = Math.max(0, this.down + this.llr(o, "down"));
      if (this.down === 0) this.downZero = i + 1;
      if ((i - this.onsetIdx.get(this.open.id)!) % 25 === 0) this.refresh(this.open, i);
      if (this.down > this.cfg.hRecovery) events.push(...this.recover(i));
    }
    this.trim();
    return events;
  }

  private alarm(i: number): MonitorEvent {
    const last = this.episodes.at(-1);
    this.down = 0;
    this.downZero = i + 1;
    this.up = 0;
    if (last && last.state === "closed" && i - this.lastCloseIdx <= this.cfg.reopenWithin && this.onsetIdx.has(last.id)) {
      // The close was premature: reopen the same episode.
      last.state = "open";
      delete last.endAt;
      delete last.endSeq;
      delete last.endDetectedAt;
      last.reopened = (last.reopened ?? 0) + 1;
      this.open = last;
      // Where the burst that caused the reopen began: the end is searched from here.
      this.reopenIdx = Math.min(Math.max(this.lastEndIdx, this.refine(this.lastEndIdx, i, "up", this.upZero)), i);
      this.refresh(last, i);
      return { type: "opened", episode: structuredClone(last) };
    }
    // Onset: directional MLE (rate goes up) over a lookback window that starts
    // no earlier than the end of the previous episode.
    const lo = Math.max(this.lastEndIdx, this.base, i - this.cfg.onsetLookback);
    const onset = Math.min(Math.max(lo, this.refine(lo, i, "up", this.upZero)), i);
    const ep = this.newEpisode(onset, i);
    this.open = ep;
    return { type: "opened", episode: structuredClone(ep) };
  }

  private newEpisode(onset: number, detected: number, retrospective = false): Episode {
    const o = this.at(onset);
    const d = this.at(detected);
    const ep: Episode = {
      id: `${this.stream}#${++this.counter}@${o.seq}`,
      stream: this.stream,
      model: o.host.modelId,
      band: this.stream.split("|")[1] ?? "all",
      state: "open",
      onsetAt: o.at,
      onsetSeq: o.seq,
      detectedAt: d.at,
      detectedSeq: d.seq,
      baselineRate: round(this.baseline ?? 0),
      episodeRate: 0,
      probes: 0,
      hallucinations: 0,
      hostAtOnset: o.host,
      attribution: [],
      attach: { model: o.host.modelId, ...(o.host.checkpoint ? { checkpoint: o.host.checkpoint } : {}), ...(o.host.quantization ? { quantization: o.host.quantization } : {}) },
      evidence: [],
      ...(retrospective ? { retrospective: true } : {}),
    };
    this.onsetIdx.set(ep.id, onset);
    this.refresh(ep, detected);
    this.episodes.push(ep);
    return ep;
  }

  private refresh(ep: Episode, last: number): void {
    const start = this.onsetIdx.get(ep.id)!;
    let probes = 0;
    let hall = 0;
    const evidence: string[] = [];
    const during: Obs[] = [];
    for (let j = Math.max(start, this.base); j <= last && j < this.end; j++) {
      const o = this.at(j);
      if (!o.charted) continue;
      probes++;
      hall += o.x;
      during.push(o);
      if (o.x === 1 && evidence.length < 25) evidence.push(o.probeId);
    }
    ep.probes = probes;
    ep.hallucinations = hall;
    ep.episodeRate = round(hall / Math.max(1, probes));
    ep.evidence = evidence;
    const before: Obs[] = [];
    for (let j = Math.max(this.base, start - this.cfg.attributionWindow); j < start; j++) before.push(this.at(j));
    ep.attribution = attribute(before, during);
  }

  private recover(i: number): MonitorEvent[] {
    const ep = this.open!;
    const start = this.onsetIdx.get(ep.id)!;
    // End: directional MLE (rate goes down) in a window around where the
    // recovery chart last left zero. Searching the whole episode would let an
    // earlier, larger burst win and hide a later one; the window never starts
    // before a reopen, which is by definition a later elevated stretch.
    const span = Math.max(4 * this.cfg.minSegment, 2 * (i - this.downZero));
    const lo = Math.max(start, this.reopenIdx ?? start, this.downZero - span);
    const end = Math.max(start + 1, Math.min(this.refine(lo, i, "down", this.downZero), i));
    this.reopenIdx = undefined;
    this.close(ep, end, i);
    this.open = undefined;
    this.lastCloseIdx = i;
    this.lastEndIdx = end;
    this.up = 0;
    this.upZero = i + 1;
    const events: MonitorEvent[] = [{ type: "closed", episode: structuredClone(ep) }];

    // Two events close together can merge while recovery is still unconfirmed:
    // split at a clear interior gap. The second part is reported retrospectively.
    const { xs, idx } = this.charted(start, end - 1);
    const b = this.baseline;
    const maxGap = b !== undefined ? (b + shiftedRate(b, this.cfg.multiplier, this.cfg.minDelta)) / 2 : 0.1;
    const gap = findRecoveryGap(xs, 0, xs.length, { maxGapRate: maxGap, minGap: this.cfg.minGap, minLR: this.cfg.gapLR });
    if (gap && gap.b < xs.length) {
      this.close(ep, idx[gap.a]!, i);
      events[0] = { type: "closed", episode: structuredClone(ep) };
      const second = this.newEpisode(idx[gap.b]!, i, true);
      second.splitFrom = ep.id;
      this.close(second, end, i);
      events.push({ type: "closed", episode: structuredClone(second) });
    }
    return events;
  }

  private close(ep: Episode, end: number, confirmed: number): void {
    const e = this.at(end);
    ep.state = "closed";
    ep.endAt = e.at;
    ep.endSeq = e.seq;
    ep.endDetectedAt = this.at(confirmed).at;
    this.refresh(ep, end - 1);
  }

  /** Drops old observations beyond the memory cap, keeping what an open episode still needs. */
  private trim(): void {
    const cap = this.cfg.maxObservations;
    if (this.obs.length <= cap * 1.25) return;
    let keepFrom = this.end - cap;
    if (this.open) keepFrom = Math.min(keepFrom, this.onsetIdx.get(this.open.id)! - this.cfg.attributionWindow);
    keepFrom = Math.max(this.base, keepFrom);
    this.obs = this.obs.slice(keepFrom - this.base);
    this.base = keepFrom;
  }
}
