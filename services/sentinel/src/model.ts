import { InfraError, mulberry32 } from "@grahmos/gate";
import type { ChatMessage } from "@grahmos/trainloop";
import { ABSTAIN } from "./probes.js";
import { stripReasoning } from "./score.js";
import type { HostContext, Probe } from "./types.js";

export interface Completion {
  text: string;
  latencyMs: number;
  /** Set when there is no usable answer: "rejected", "empty", "length", "reasoning_only". */
  invalid?: string;
}

export interface ModelClient {
  readonly name: string;
  /** Completion budget, used to keep prompt + answer inside the context window. */
  readonly maxTokens?: number;
  /** `probe` is only for simulated models; real clients must ignore it. */
  complete(messages: ChatMessage[], opts: { signal?: AbortSignal; probe?: Probe; host?: HostContext }): Promise<Completion>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * Any OpenAI-compatible chat endpoint: vLLM and llama.cpp on AGSI Core,
 * Ollama, LM Studio, or a hosted API. Probes run at temperature 0 by default
 * so a change in the hallucination rate reflects the model and host, not
 * sampling noise.
 */
export class OpenAICompatibleModel implements ModelClient {
  readonly name: string;
  constructor(
    private readonly o: {
      model: string;
      baseUrl: string;
      apiKey?: string;
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      /** Ask reasoning models (Qwen3 and similar on vLLM) to answer without a thinking block. */
      disableThinking?: boolean;
      fetch?: FetchLike;
    },
  ) {
    this.name = o.model;
  }

  get maxTokens(): number {
    return this.o.maxTokens ?? 64;
  }

  async complete(messages: ChatMessage[], opts: { signal?: AbortSignal } = {}): Promise<Completion> {
    const f = this.o.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 120_000);
    const onAbort = () => ctl.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await f(`${this.o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.o.model,
          messages,
          temperature: this.o.temperature ?? 0,
          max_tokens: this.maxTokens,
          ...(this.o.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        }),
        signal: ctl.signal,
      });
      const latencyMs = () => performance.now() - t0;
      if (!res.ok) {
        const msg = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        // Context-length rejections say something about the deployment, not the
        // model's honesty: logged as invalid, never scored as a hallucination.
        if (res.status === 400 && /context|token|length/i.test(msg)) return { text: `[rejected: ${msg}]`, latencyMs: latencyMs(), invalid: "rejected" };
        throw new InfraError(msg);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string | null }; finish_reason?: string | null }[] };
      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? "";
      const answer = stripReasoning(text);
      // Cut off at max_tokens: the model was still talking, so the answer is incomplete.
      if (choice?.finish_reason === "length") return { text, latencyMs: latencyMs(), invalid: "length" };
      if (!answer) return { text, latencyMs: latencyMs(), invalid: text.trim() ? "reasoning_only" : "empty" };
      return { text, latencyMs: latencyMs() };
    } catch (e) {
      if (e instanceof InfraError) throw e;
      throw new InfraError(`model call failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Simulated model with a known hallucination rate, for demos and for testing
 * the detector against ground truth. `rate` decides, per probe, how likely a
 * hallucination is given the probe and the current host conditions.
 */
export class SimulatedModel implements ModelClient {
  private readonly r: () => number;
  constructor(
    readonly name: string,
    private readonly rate: (probe: Probe, host: HostContext | undefined) => number,
    seed = 7,
  ) {
    this.r = mulberry32(seed);
  }

  async complete(_messages: ChatMessage[], opts: { probe?: Probe; host?: HostContext }): Promise<Completion> {
    const p = opts.probe;
    if (!p) return { text: ABSTAIN, latencyMs: 1 };
    if (this.r() < this.rate(p, opts.host)) {
      // Hallucinate: borrow a value from another record, or invent one.
      const wrong = p.distractors.find((d) => d !== p.reference) ?? `${Math.floor(this.r() * 900) + 100}`;
      return { text: wrong, latencyMs: 5 };
    }
    // Mostly right; occasionally an honest abstention on a grounded question.
    if (p.kind === "grounded" && this.r() < 0.02) return { text: ABSTAIN, latencyMs: 5 };
    return { text: p.reference, latencyMs: 5 };
  }
}
