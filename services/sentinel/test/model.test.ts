import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { InfraError } from "@grahmos/gate";
import { OpenAICompatibleModel, SimulatedModel } from "../src/model.js";
import { ABSTAIN, generateProbe } from "../src/probes.js";
import { scoreAnswer } from "../src/score.js";

type Init = { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal };
const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

function fakeFetch(respond: (url: string, init: Init) => ReturnType<typeof reply> | Promise<ReturnType<typeof reply>>) {
  const calls: { url: string; init: Init }[] = [];
  const f = async (url: string, init: Init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { f, calls };
}

const messages = [
  { role: "system" as const, content: "sys" },
  { role: "user" as const, content: "doc\n\nQuestion: q?" },
];

describe("OpenAICompatibleModel", () => {
  it("posts a deterministic chat completion request and returns the text", async () => {
    const { f, calls } = fakeFetch(() => reply(200, { choices: [{ message: { content: "450" } }] }));
    const m = new OpenAICompatibleModel({ model: "qwen", baseUrl: "http://llm.invalid/v1/", apiKey: "k-1", fetch: f });
    expect(m.name).toBe("qwen");
    const c = await m.complete(messages);
    expect(c.text).toBe("450");
    expect(c.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://llm.invalid/v1/chat/completions");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer k-1" });
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ model: "qwen", messages, temperature: 0, max_tokens: 64 });
    expect(c.invalid).toBeUndefined();
    expect(m.maxTokens).toBe(64);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("honours temperature / maxTokens overrides and omits auth without a key", async () => {
    const { f, calls } = fakeFetch(() => reply(200, { choices: [{ message: { content: null } }] }));
    const m = new OpenAICompatibleModel({ model: "x", baseUrl: "http://llm.invalid/v1", temperature: 0.7, maxTokens: 8, fetch: f });
    expect(await m.complete(messages)).toMatchObject({ text: "", invalid: "empty" });
    expect(m.maxTokens).toBe(8);
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({ temperature: 0.7, max_tokens: 8 });
    expect(calls[0]!.init.headers.authorization).toBeUndefined();
  });

  it("returns an empty, invalid answer when the response has no choices", async () => {
    const { f } = fakeFetch(() => reply(200, {}));
    expect(await new OpenAICompatibleModel({ model: "x", baseUrl: "http://llm.invalid", fetch: f }).complete(messages)).toMatchObject({ text: "", invalid: "empty" });
  });

  it("marks truncated, reasoning-only and empty answers invalid", async () => {
    const run = async (choice: unknown) => {
      const { f } = fakeFetch(() => reply(200, { choices: [choice] }));
      return new OpenAICompatibleModel({ model: "x", baseUrl: "http://llm.invalid", fetch: f }).complete(messages);
    };
    expect(await run({ message: { content: "The rating is 45" }, finish_reason: "length" })).toMatchObject({ text: "The rating is 45", invalid: "length" });
    expect(await run({ message: { content: "<think>let me see" }, finish_reason: "length" })).toMatchObject({ invalid: "length" });
    expect(await run({ message: { content: "<think>hmm</think>" }, finish_reason: "stop" })).toMatchObject({ text: "<think>hmm</think>", invalid: "reasoning_only" });
    expect(await run({ message: { content: "   " }, finish_reason: "stop" })).toMatchObject({ invalid: "empty" });
    const ok = await run({ message: { content: "<think>hmm</think>450" }, finish_reason: "stop" });
    expect(ok.text).toBe("<think>hmm</think>450");
    expect(ok.invalid).toBeUndefined();
  });

  it("disableThinking sends chat_template_kwargs.enable_thinking=false", async () => {
    const { f, calls } = fakeFetch(() => reply(200, { choices: [{ message: { content: "1" } }] }));
    await new OpenAICompatibleModel({ model: "x", baseUrl: "http://llm.invalid", disableThinking: true, fetch: f }).complete(messages);
    await new OpenAICompatibleModel({ model: "x", baseUrl: "http://llm.invalid", fetch: f }).complete(messages);
    expect(JSON.parse(calls[0]!.init.body).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(JSON.parse(calls[1]!.init.body).chat_template_kwargs).toBeUndefined();
  });

  it("returns a 400 context-length error as rejection text, not an outage", async () => {
    const { f } = fakeFetch(() => reply(400, "This model's maximum context length is 8192 tokens"));
    const c = await new OpenAICompatibleModel({ model: "x", baseUrl: "http://llm.invalid", fetch: f }).complete(messages);
    expect(c.text).toBe("[rejected: HTTP 400: This model's maximum context length is 8192 tokens]");
    expect(c.invalid).toBe("rejected");
  });

  it("other 400s and 5xx are InfraErrors", async () => {
    for (const [status, body] of [
      [400, "bad request: unknown field"],
      [500, "internal error"],
      [503, "overloaded"],
      [429, "rate limited"],
    ] as const) {
      const { f } = fakeFetch(() => reply(status, body));
      const p = new OpenAICompatibleModel({ model: "x", baseUrl: "http://llm.invalid", fetch: f }).complete(messages);
      await expect(p).rejects.toBeInstanceOf(InfraError);
      await expect(p).rejects.toThrow(`HTTP ${status}: ${body}`);
    }
  });

  it("truncates long error bodies", async () => {
    const { f } = fakeFetch(() => reply(500, "e".repeat(1000)));
    await expect(new OpenAICompatibleModel({ model: "x", baseUrl: "http://llm.invalid", fetch: f }).complete(messages)).rejects.toThrow(new RegExp(`^HTTP 500: e{200}$`));
  });

  it("network errors and bad JSON become InfraErrors", async () => {
    const net = new OpenAICompatibleModel({ model: "x", baseUrl: "http://llm.invalid", fetch: async () => Promise.reject(new TypeError("fetch failed")) });
    await expect(net.complete(messages)).rejects.toBeInstanceOf(InfraError);
    await expect(net.complete(messages)).rejects.toThrow("model call failed: fetch failed");
    const badJson = new OpenAICompatibleModel({
      model: "x",
      baseUrl: "http://llm.invalid",
      fetch: async () => ({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError("Unexpected token")), text: async () => "" }),
    });
    await expect(badJson.complete(messages)).rejects.toBeInstanceOf(InfraError);
  });

  it("times out via its own abort controller", async () => {
    const hang = (_url: string, init: Init) =>
      new Promise<never>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const m = new OpenAICompatibleModel({ model: "x", baseUrl: "http://llm.invalid", timeoutMs: 20, fetch: hang });
    await expect(m.complete(messages)).rejects.toThrow(/model call failed: aborted/);
  });

  it("propagates the caller's abort signal", async () => {
    const hang = (_url: string, init: Init) =>
      new Promise<never>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    const ctl = new AbortController();
    const m = new OpenAICompatibleModel({ model: "x", baseUrl: "http://llm.invalid", fetch: hang });
    const p = m.complete(messages, { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toBeInstanceOf(InfraError);
  });

  // Regression: complete() used to leave its "abort" listener on the caller's signal.
  it("does not leave listeners on the caller's signal after the call", async () => {
    const { f } = fakeFetch(() => reply(200, { choices: [{ message: { content: "1" } }] }));
    const m = new OpenAICompatibleModel({ model: "x", baseUrl: "http://llm.invalid", fetch: f });
    const ctl = new AbortController();
    for (let k = 0; k < 5; k++) await m.complete(messages, { signal: ctl.signal });
    expect(getEventListeners(ctl.signal, "abort")).toHaveLength(0);
    // Also after a failed call.
    const failing = new OpenAICompatibleModel({ model: "x", baseUrl: "http://llm.invalid", fetch: async () => Promise.reject(new Error("down")) });
    await expect(failing.complete(messages, { signal: ctl.signal })).rejects.toBeInstanceOf(InfraError);
    expect(getEventListeners(ctl.signal, "abort")).toHaveLength(0);
  });
});

describe("SimulatedModel", () => {
  const bands = { bands: [400] };

  it("is deterministic for a seed and answers correctly at rate 0", async () => {
    const m = new SimulatedModel("sim", () => 0, 3);
    let abstained = 0;
    for (let seq = 0; seq < 60; seq++) {
      const p = generateProbe(1, seq, bands);
      const { outcome } = scoreAnswer(p, (await m.complete(p.messages, { probe: p })).text);
      expect(outcome).not.toBe("hallucinated");
      if (outcome === "abstained") abstained++;
    }
    expect(abstained).toBeLessThan(6);
    const a = new SimulatedModel("sim", () => 0.5, 9);
    const b = new SimulatedModel("sim", () => 0.5, 9);
    for (let seq = 0; seq < 20; seq++) {
      const p = generateProbe(1, seq, bands);
      expect(await a.complete(p.messages, { probe: p })).toEqual(await b.complete(p.messages, { probe: p }));
    }
  });

  it("always hallucinates at rate 1, borrowing distractors when present", async () => {
    const m = new SimulatedModel("sim", () => 1, 3);
    for (let seq = 0; seq < 24; seq++) {
      const p = generateProbe(1, seq, { bands: [2000] });
      const text = (await m.complete(p.messages, { probe: p })).text;
      expect(scoreAnswer(p, text).outcome).toBe("hallucinated");
      if (p.distractors.some((d) => d !== p.reference)) expect(p.distractors).toContain(text);
    }
  });

  it("abstains without a probe and passes host context to the rate", async () => {
    const seen: unknown[] = [];
    const m = new SimulatedModel("sim", (_p, host) => (seen.push(host), 0));
    expect((await m.complete([], {})).text).toBe(ABSTAIN);
    const p = generateProbe(1, 0, bands);
    await m.complete(p.messages, { probe: p, host: { modelId: "z", kvPressure: 0.9 } });
    expect(seen).toEqual([{ modelId: "z", kvPressure: 0.9 }]);
  });
});
