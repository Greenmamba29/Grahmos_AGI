import type { ChatMessage } from "@grahmos/trainloop";
import type { ValueType } from "./probes.js";

/** Host conditions at the moment a probe ran. AGSI Core's orchestrator pushes these (POST /context). */
export interface HostContext {
  modelId: string;
  checkpoint?: string;
  quantization?: string;
  /** KV-cache occupancy 0..1. */
  kvPressure?: number;
  /** Fraction of throughput removed by thermal/battery derating, 0..1. */
  thermalDerate?: number;
  gpuTempC?: number;
  /** Requests waiting in the inference queue. */
  queueDepth?: number;
  /** True while user agents are using the box; Sentinel only probes when false. */
  busy?: boolean;
  /** Free-form extra numeric signals, attributed like the named ones. */
  extra?: Record<string, number>;
}

export type ProbeKind = "grounded" | "unanswerable";

export interface Probe {
  id: string;
  seq: number;
  family: string;
  template: string;
  kind: ProbeKind;
  attrKey: string;
  valueType: ValueType;
  /** The question asked (its own numbers and codes are never counted as answers). */
  question: string;
  /** Conservative prompt-size estimate in tokens (chars / 3). */
  contextTokens: number;
  band: number;
  messages: ChatMessage[];
  /** The grounded reference answer (value, or ABSTAIN for unanswerable). */
  reference: string;
  /** Other values present in the document that a confused model might give. */
  distractors: string[];
}

/**
 * invalid: no usable answer (empty, cut off at the token limit, rejected by
 * the server, or only reasoning text). Logged and counted, never charted.
 */
export type Outcome = "correct" | "hallucinated" | "abstained" | "invalid";

export interface ProbeResult {
  probeId: string;
  family: string;
  template: string;
  kind: ProbeKind;
  pool: string;
  /**
   * monitor: feeds detection. train: only feeds preference pairs.
   * excluded: retired (leaked) family, logged but used for nothing.
   */
  role: "monitor" | "train" | "excluded";
  /** Generator inputs, so the exact probe can be regenerated and checked later. */
  seed?: number;
  bands?: number[];
  probeSeq?: number;
  /** Caller's id for a live observation (POST /observe). */
  requestId?: string;
  /** Why the answer was unusable (outcome "invalid"). */
  invalidReason?: string;
  stream: string;
  band: number;
  contextTokens: number;
  answer: string;
  reference: string;
  outcome: Outcome;
  hallucinated: boolean;
  /** Present when the wrong answer was a value from elsewhere in the document. */
  confusedWith?: string;
  latencyMs: number;
  at: string;
  seq: number;
  host: HostContext;
}

export interface Attribution {
  factor: string;
  baseline: number | string;
  inEpisode: number | string;
  /** Standardized difference for numeric factors (|Δmean| / pooled sd), or 1 when a categorical value changed. */
  effect: number;
}

export interface Episode {
  id: string;
  stream: string;
  model: string;
  band: string;
  state: "open" | "closed";
  /** Estimated first affected probe (CUSUM change-point estimate). */
  onsetAt: string;
  onsetSeq: number;
  /** When the alarm fired. */
  detectedAt: string;
  detectedSeq: number;
  /** Estimated first recovered probe. */
  endAt?: string;
  endSeq?: number;
  endDetectedAt?: string;
  baselineRate: number;
  /** Observed hallucination rate between onset and end (or now). */
  episodeRate: number;
  probes: number;
  hallucinations: number;
  /** Host conditions at onset and how conditions in the episode differed from just before it. */
  hostAtOnset: HostContext;
  attribution: Attribution[];
  /** What the episode is attached to. */
  attach: { model: string; checkpoint?: string; quantization?: string };
  evidence: string[];
  /** Set when this episode was split out of a longer one at a recovery gap. */
  splitFrom?: string;
  /** Times the episode was reopened after a premature close. */
  reopened?: number;
  /** Found after the fact (split out of a longer episode at close time); never announced as "opened". */
  retrospective?: boolean;
}

export type SentinelEvent =
  | { type: "probe.result"; result: ProbeResult }
  | { type: "episode.opened"; episode: Episode }
  | { type: "episode.closed"; episode: Episode }
  /** A band's normal hallucination rate is itself too high: a standing problem, not an episode. */
  | { type: "baseline.high"; stream: string; stratum: string; baseline: number }
  | { type: "contamination"; probeId: string; canaries: string[] };

export interface EventSink {
  emit(e: SentinelEvent): void | Promise<void>;
}
