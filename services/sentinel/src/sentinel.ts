import { appendFileSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { AuditLog, forEachLine, InfraError, sha256 } from "@grahmos/gate";
import { findCanaries, type PairSource, type PoolManager } from "@grahmos/trainloop";
import { DEFAULT_MONITOR, StreamMonitor, type MonitorConfig, type MonitorEvent } from "./episodes.js";
import type { ModelClient } from "./model.js";
import { DEFAULT_BANDS, generateProbe } from "./probes.js";
import { checkGrounding, scoreAnswer } from "./score.js";
import type { Episode, EventSink, HostContext, Outcome, Probe, ProbeResult, SentinelEvent } from "./types.js";

/**
 * Sentinel: runs hallucination probes continuously while the box is idle,
 * detects when hallucination episodes begin and end, attaches each episode
 * to the model/checkpoint and host conditions it happened under, and keeps
 * hash-chained evidence of all of it.
 *
 * Streams, per model:
 *   <model>|<band>  one per context band (1k, 4k, 16k, 32k)
 *   <model>|all     every band together, each band against its own baseline
 *                   (stratified), so it reacts to problems that hit all bands
 *                   without raising alarms just because bands differ
 *   <model>|live    grounding checks on real traffic (POST /observe)
 *
 * Pools: probe families in the TRAIN pool are run and logged but never used
 * for detection — their hallucinations become preference pairs for training.
 * Detection uses only the other families, so training cannot quietly improve
 * the monitor's own probes and hide a regression. Retired (leaked) families
 * are logged and used for nothing.
 */

export interface HostContextSource {
  current(): HostContext;
}

export class PushedHostContext implements HostContextSource {
  private ctx: HostContext;
  constructor(initial: HostContext) {
    this.ctx = initial;
  }
  current(): HostContext {
    return this.ctx;
  }
  /** Called by the orchestrator (POST /context) whenever host telemetry changes. */
  push(update: Partial<HostContext>): HostContext {
    this.ctx = { ...this.ctx, ...update };
    return this.ctx;
  }
}

export interface SentinelOptions {
  model: ModelClient;
  host: HostContextSource;
  dataDir: string;
  pools?: PoolManager;
  bands?: number[];
  /** Model context window in tokens; bands that would not fit (with margin and the answer budget) are skipped. */
  maxContextTokens?: number;
  seed?: number;
  monitor?: Partial<MonitorConfig>;
  sinks?: EventSink[];
  auditKey?: string;
  /** Upper bound on monitored streams (protects memory from arbitrary model ids). */
  maxStreams?: number;
  /** Clock override (demos replay time faster than real time). */
  now?: () => Date;
}

/**
 * Pool split for probe families. Most families must stay on the monitor side:
 * detection needs enough observations per (model, band) stream to estimate a
 * baseline quickly. A quarter of families feed training.
 */
export const SENTINEL_POOL_RATIOS = { train: 0.25, dev: 0.45, holdout: 0.25, canary: 0.05 };

export const bandLabel = (b: number) => (b >= 1000 ? `${Math.round(b / 1000)}k` : `${b}`);

/** Prompt estimate × this margin + answer budget must fit the context window. */
const CONTEXT_MARGIN = 1.1;
const RECENT = 5000;

/** Cuts a JSONL file back to its last complete line (a crash mid-write leaves a torn tail). */
export function repairTail(path: string): boolean {
  if (!existsSync(path)) return false;
  const size = statSync(path).size;
  if (size === 0) return false;
  const fd = openSync(path, "r+");
  try {
    const one = Buffer.alloc(1);
    readSync(fd, one, 0, 1, size - 1);
    if (one[0] === 10) return false;
    // Scan backwards for the last newline.
    const chunk = Buffer.alloc(64 * 1024);
    let pos = size;
    while (pos > 0) {
      const start = Math.max(0, pos - chunk.length);
      const n = readSync(fd, chunk, 0, pos - start, start);
      const nl = chunk.subarray(0, n).lastIndexOf(10);
      if (nl !== -1) {
        ftruncateSync(fd, start + nl + 1);
        return true;
      }
      pos = start;
    }
    ftruncateSync(fd, 0);
    return true;
  } finally {
    closeSync(fd);
  }
}

export class Sentinel {
  readonly monitors = new Map<string, StreamMonitor>();
  /** Most recent results (bounded); counts below cover everything. */
  private readonly recent: ProbeResult[] = [];
  private readonly trainHallucinations: ProbeResult[] = [];
  private readonly outcomes: Record<Outcome, number> = { correct: 0, hallucinated: 0, abstained: 0, invalid: 0 };
  private readonly invalidReasons: Record<string, number> = {};
  private total = 0;
  private seq = 0;
  private readonly audit: AuditLog;
  private readonly cfg: MonitorConfig;
  readonly bands: number[];
  private readonly seed: number;
  private readonly now: () => Date;
  private stopped = false;
  infraErrors = 0;
  /** Logged probes dropped at replay because they had no matching audit entry. */
  replayRejected = 0;
  /** Torn tails cut off at startup (files). */
  repairedFiles: string[] = [];

  constructor(private readonly o: SentinelOptions) {
    mkdirSync(o.dataDir, { recursive: true });
    this.cfg = { ...DEFAULT_MONITOR, ...o.monitor };
    this.seed = o.seed ?? 1;
    const budget = o.model.maxTokens ?? 64;
    this.bands = (o.bands ?? DEFAULT_BANDS).filter((b) => !o.maxContextTokens || b * CONTEXT_MARGIN + budget <= o.maxContextTokens);
    if (this.bands.length === 0) throw new Error("no probe bands fit maxContextTokens");
    this.now = o.now ?? (() => new Date());
    for (const f of [this.probesPath, this.auditPath, join(o.dataDir, "episodes.jsonl")]) if (repairTail(f)) this.repairedFiles.push(f);
    const answerHashes = new Map<string, string>();
    this.audit = AuditLog.resume({
      filePath: this.auditPath,
      hmacKey: o.auditKey,
      now: this.now,
      retain: false,
      onEntry: (e) => {
        if (e.type !== "probe") return;
        const p = e.payload as { probeId?: string; answerSha256?: string };
        if (p.probeId && p.answerSha256) answerHashes.set(p.probeId, p.answerSha256);
      },
    });
    this.replay(answerHashes);
  }

  private get probesPath() {
    return join(this.o.dataDir, "probes.jsonl");
  }
  private get auditPath() {
    return join(this.o.dataDir, "audit.jsonl");
  }

  /**
   * Rebuilds detector state from the probe log after a restart (detection is
   * deterministic). Only results whose answer hash matches the audit chain
   * are replayed, so an edited probes.jsonl cannot rewrite history.
   */
  private replay(answerHashes: Map<string, string>): void {
    if (!existsSync(this.probesPath)) return;
    forEachLine(this.probesPath, (line, complete) => {
      if (!complete || !line.trim()) return;
      let r: ProbeResult;
      try {
        r = JSON.parse(line) as ProbeResult;
      } catch {
        this.replayRejected++;
        return;
      }
      if (answerHashes.get(r.probeId) !== sha256(r.answer)) {
        this.replayRejected++;
        return;
      }
      try {
        this.ingest(r, false);
      } catch (e) {
        // Over the stream cap (e.g. the cap was lowered): skip, never refuse to start.
        if (!(e instanceof RangeError)) throw e;
        this.replayRejected++;
      }
      this.seq = Math.max(this.seq, (r.probeSeq ?? r.seq) + 1, r.seq + 1);
    });
  }

  private monitor(stream: string): StreamMonitor {
    let m = this.monitors.get(stream);
    if (!m) {
      if (this.monitors.size >= (this.o.maxStreams ?? 64)) throw new RangeError(`stream limit reached (${this.o.maxStreams ?? 64}); not creating ${stream}`);
      m = new StreamMonitor(stream, this.cfg);
      this.monitors.set(stream, m);
    }
    return m;
  }

  /** Whether a stream exists or could be created (for API input checks). */
  canMonitor(model: string): boolean {
    return [...this.monitors.keys()].some((s) => s.startsWith(`${model}|`)) || this.monitors.size + 3 <= (this.o.maxStreams ?? 64);
  }

  private async emit(e: SentinelEvent): Promise<void> {
    for (const s of this.o.sinks ?? []) {
      try {
        await s.emit(e);
      } catch {
        /* a failing sink never stops monitoring */
      }
    }
  }

  private toEvent(stream: string, ev: MonitorEvent): SentinelEvent {
    if (ev.type === "baseline_high") return { type: "baseline.high", stream, stratum: ev.stratum ?? "", baseline: ev.baseline ?? 0 };
    return { type: ev.type === "opened" ? "episode.opened" : "episode.closed", episode: ev.episode! };
  }

  /** Feeds one result into its streams; returns episode and baseline events. */
  private ingest(r: ProbeResult, live: boolean): SentinelEvent[] {
    this.total++;
    this.outcomes[r.outcome] = (this.outcomes[r.outcome] ?? 0) + 1;
    if (r.outcome === "invalid") this.invalidReasons[r.invalidReason ?? "unknown"] = (this.invalidReasons[r.invalidReason ?? "unknown"] ?? 0) + 1;
    this.recent.push(r);
    if (this.recent.length > RECENT * 1.2) this.recent.splice(0, this.recent.length - RECENT);
    if (r.role === "train" && r.hallucinated) this.trainHallucinations.push(r);

    const events: SentinelEvent[] = [];
    const streams = this.streamsFor(r);
    if (!streams.length) return events;
    const isLive = r.stream.endsWith("|live");
    const stratum = isLive ? "live" : bandLabel(r.band);
    const obs = { seq: r.seq, at: r.at, x: (r.hallucinated ? 1 : 0) as 0 | 1, probeId: r.probeId, host: r.host, stratum, contextTokens: r.contextTokens };
    for (const s of streams) {
      for (const ev of this.monitor(s).add(obs)) {
        const e = this.toEvent(s, ev);
        events.push(e);
        if (!live) continue;
        this.audit.append(e.type, "episode" in e ? e.episode : e);
        if ("episode" in e) appendFileSync(join(this.o.dataDir, "episodes.jsonl"), `${JSON.stringify(e.episode)}\n`);
      }
    }
    return events;
  }

  /** Streams a result will feed. */
  private streamsFor(r: ProbeResult): string[] {
    if (r.role !== "monitor" || r.outcome === "invalid") return [];
    return r.stream.endsWith("|live") ? [r.stream] : [r.stream, `${r.host.modelId}|all`];
  }

  private record(r: ProbeResult): SentinelEvent[] {
    // Check capacity before writing anything: a logged result that cannot be
    // charted would make the data dir fail to replay.
    const missing = this.streamsFor(r).filter((s) => !this.monitors.has(s)).length;
    if (missing && this.monitors.size + missing > (this.o.maxStreams ?? 64)) throw new RangeError(`stream limit reached (${this.o.maxStreams ?? 64}); not recording ${r.stream}`);
    // Audit first: a probe line without its audit entry is dropped at replay.
    this.audit.append("probe", {
      probeId: r.probeId,
      family: r.family,
      pool: r.pool,
      role: r.role,
      stream: r.stream,
      outcome: r.outcome,
      seq: r.seq,
      answerSha256: sha256(r.answer),
      contextTokens: r.contextTokens,
      model: r.host.modelId,
    });
    appendFileSync(this.probesPath, `${JSON.stringify(r)}\n`);
    return this.ingest(r, true);
  }

  private nextProbe(): Probe {
    return generateProbe(this.seed, this.seq++, { bands: this.bands });
  }

  private roleOf(family: string): { pool: string; role: ProbeResult["role"] } {
    const pool = this.o.pools?.poolOf(family) ?? "monitor";
    return { pool, role: pool === "train" ? "train" : pool === "retired" ? "excluded" : "monitor" };
  }

  /** Runs one probe now (ignores `busy`). Returns null if the model call failed for infrastructure reasons. */
  async probeOnce(signal?: AbortSignal): Promise<ProbeResult | null> {
    // Everything that identifies this probe is fixed before the await, so
    // concurrent calls (a timer probe and a manual one) cannot swap numbers.
    const probe = this.nextProbe();
    const host = { ...this.o.host.current() };
    const at = this.now().toISOString();
    let text: string;
    let latencyMs: number;
    let invalid: string | undefined;
    try {
      const c = await this.o.model.complete(probe.messages, { signal, probe, host });
      text = c.text;
      latencyMs = Math.round(c.latencyMs);
      invalid = c.invalid;
    } catch (e) {
      if (!(e instanceof InfraError)) throw e;
      this.infraErrors++;
      return null;
    }
    const { pool, role } = this.roleOf(probe.family);
    const scored = invalid ? { outcome: "invalid" as const } : scoreAnswer(probe, text);
    const outcome = scored.outcome;
    const r: ProbeResult = {
      probeId: probe.id,
      family: probe.family,
      template: probe.template,
      kind: probe.kind,
      pool,
      role,
      seed: this.seed,
      bands: this.bands,
      probeSeq: probe.seq,
      ...(outcome === "invalid" ? { invalidReason: invalid ?? "empty" } : {}),
      stream: `${host.modelId}|${bandLabel(probe.band)}`,
      band: probe.band,
      contextTokens: probe.contextTokens,
      answer: text,
      reference: probe.reference,
      outcome,
      hallucinated: outcome === "hallucinated",
      ...("confusedWith" in scored && scored.confusedWith ? { confusedWith: scored.confusedWith } : {}),
      latencyMs,
      at,
      seq: probe.seq,
      host,
    };
    const canaries = findCanaries(text);
    const events = this.record(r);
    await this.emit({ type: "probe.result", result: r });
    if (canaries.length) await this.emit({ type: "contamination", probeId: probe.id, canaries });
    for (const e of events) await this.emit(e);
    return r;
  }

  /**
   * Live-traffic check: the orchestrator sends an answer and the sources it
   * was given; numbers and quotes not found in the sources count as a
   * hallucination on the model's "live" stream.
   */
  async observe(input: { answer: string; sources: string[]; host?: Partial<HostContext>; id?: string }): Promise<{ result: ProbeResult; unsupported: string[] }> {
    const host = { ...this.o.host.current(), ...input.host };
    const g = checkGrounding(input.answer, input.sources);
    const seq = this.seq++;
    const r: ProbeResult = {
      // Sentinel's own id is always unique; the caller's id is kept alongside.
      probeId: `live-${seq}`,
      ...(input.id ? { requestId: input.id } : {}),
      family: "live",
      template: "live",
      kind: "grounded",
      pool: "live",
      role: "monitor",
      stream: `${host.modelId}|live`,
      band: 0,
      contextTokens: Math.round(input.sources.join("\n").length / 4),
      answer: input.answer,
      reference: "",
      outcome: g.supported ? "correct" : "hallucinated",
      hallucinated: !g.supported,
      latencyMs: 0,
      at: this.now().toISOString(),
      seq,
      host,
    };
    const events = this.record(r);
    for (const e of events) await this.emit(e);
    return { result: r, unsupported: g.unsupported };
  }

  /** Probes continuously while the host is idle, at most one probe per `intervalMs`. */
  async run(opts: { intervalMs: number; signal?: AbortSignal; maxProbes?: number }): Promise<void> {
    let n = 0;
    while (!this.stopped && !opts.signal?.aborted && (opts.maxProbes === undefined || n < opts.maxProbes)) {
      if (!this.o.host.current().busy) {
        await this.probeOnce(opts.signal);
        n++;
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          opts.signal?.removeEventListener("abort", done);
          resolve();
        };
        const t = setTimeout(done, opts.intervalMs);
        opts.signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  stop(): void {
    this.stopped = true;
  }

  // ------------------------------------------------------------ queries

  status() {
    return {
      model: this.o.model.name,
      bands: this.bands.map(bandLabel),
      probes: this.total,
      outcomes: { ...this.outcomes },
      invalidReasons: { ...this.invalidReasons },
      infraErrors: this.infraErrors,
      replayRejected: this.replayRejected,
      auditHead: this.audit.head,
      auditEntries: this.audit.count,
      streams: [...this.monitors.values()]
        .map((m) => ({
          stream: m.stream,
          state: m.state,
          observations: m.count,
          baseline: m.baseline ?? null,
          baselines: m.baselines,
          unstableStrata: m.unstableStrata,
          recentRate: m.recentRate(),
          statistic: m.statistic,
          threshold: m.state === "episode" ? this.cfg.hRecovery : this.cfg.h,
          openEpisode: m.current ?? null,
        }))
        .sort((a, b) => a.stream.localeCompare(b.stream)),
    };
  }

  episodes(): Episode[] {
    return [...this.monitors.values()].flatMap((m) => m.episodes.map((e) => structuredClone(e))).sort((a, b) => a.onsetSeq - b.onsetSeq);
  }

  /** Rolling hallucination rate for a stream, for charts. */
  series(stream: string, window = 25): { seq: number; at: string; rate: number }[] {
    const w = Math.max(1, Math.floor(window) || 1);
    const obs = this.monitors.get(stream)?.observations ?? [];
    const out: { seq: number; at: string; rate: number }[] = [];
    let sum = 0;
    for (let i = 0; i < obs.length; i++) {
      sum += obs[i]!.x;
      if (i >= w) sum -= obs[i - w]!.x;
      out.push({ seq: obs[i]!.seq, at: obs[i]!.at, rate: sum / Math.min(i + 1, w) });
    }
    return out;
  }

  /** The most recent results (bounded window). */
  get allResults(): readonly ProbeResult[] {
    return this.recent;
  }

  /**
   * Hallucinations on TRAIN-pool probes, as sources for preference pairs
   * (feed to @grahmos/trainloop exportPreferencePairs). Each probe is
   * regenerated from the seed and bands it was logged with and checked
   * against the logged family and reference; anything that does not match
   * exactly is skipped rather than paired with the wrong prompt.
   */
  pairSources(): PairSource[] {
    const out: PairSource[] = [];
    for (const r of this.trainHallucinations) {
      if (r.seed === undefined || !r.bands?.length || r.probeSeq === undefined) continue;
      const p = generateProbe(r.seed, r.probeSeq, { bands: r.bands });
      if (p.id !== r.probeId || p.family !== r.family || p.reference !== r.reference) continue;
      out.push({ probeId: r.probeId, family: r.family, prompt: p.messages, answer: r.answer, reference: p.reference, hallucinated: true, model: r.host.modelId, contextTokens: r.contextTokens });
    }
    return out;
  }

  get modelName(): string {
    return this.o.model.name;
  }

  get auditHead(): string {
    return this.audit.head;
  }
}

/** Appends every event to a JSONL file. */
export class JsonlSink implements EventSink {
  constructor(private readonly path: string) {}
  emit(e: SentinelEvent): void {
    appendFileSync(this.path, `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`);
  }
}

/** POSTs episode and baseline events (not every probe) to a URL, e.g. an orchestrator route that republishes on NATS. */
export class WebhookSink implements EventSink {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5000,
  ) {}
  async emit(e: SentinelEvent): Promise<void> {
    if (e.type === "probe.result") return;
    await this.fetchImpl(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e), signal: AbortSignal.timeout(this.timeoutMs) });
  }
}
