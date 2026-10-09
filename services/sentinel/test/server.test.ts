import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { cleanContext, serveSentinel } from "../src/server.js";
import { drive, makeHarness, tempDir, type Harness } from "./helpers.js";

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function start(h: Harness, token?: string, allowedHosts?: string[]): Promise<string> {
  server = serveSentinel(h.sentinel, h.host, { ...(token ? { token } : {}), ...(allowedHosts ? { allowedHosts } : {}) });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("serveSentinel", () => {
  it("serves /status, /episodes, /series and /report", async () => {
    const h = makeHarness(tempDir());
    await drive(h, 450);
    const base = await start(h);

    const status = await json(await fetch(`${base}/status`));
    expect(status).toEqual(JSON.parse(JSON.stringify(h.sentinel.status())));
    expect(status.probes).toBe(450);

    const eps = await json(await fetch(`${base}/episodes`));
    expect(eps.episodes).toEqual(JSON.parse(JSON.stringify(h.sentinel.episodes())));
    expect((eps.episodes as unknown[]).length).toBeGreaterThan(0);

    const series = await json(await fetch(`${base}/series?stream=${encodeURIComponent("m|all")}&window=10`));
    expect(series.stream).toBe("m|all");
    expect(series.series).toEqual(h.sentinel.series("m|all", 10));
    const empty = await json(await fetch(`${base}/series?stream=nope`));
    expect(empty).toEqual({ stream: "nope", series: [] });

    const report = await fetch(`${base}/report`);
    expect(report.status).toBe(200);
    expect(report.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await report.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<svg");

    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await post(`${base}/status`, {})).status).toBe(404);
  });

  it("series uses window 25 by default", async () => {
    const h = makeHarness(tempDir());
    await drive(h, 60);
    const base = await start(h);
    const s = await json(await fetch(`${base}/series?stream=${encodeURIComponent("m|all")}`));
    expect(s.series).toEqual(h.sentinel.series("m|all", 25));
  });

  // Regression: window=0 used to make every rate NaN.
  it("series clamps the window to 1..1000", async () => {
    const h = makeHarness(tempDir());
    await drive(h, 60);
    const base = await start(h);
    const get = async (w: string) => (await json(await fetch(`${base}/series?stream=${encodeURIComponent("m|all")}&window=${w}`))).series as { rate: unknown }[];
    for (const w of ["0", "-5", "abc", "1e9"]) for (const p of await get(w)) expect(typeof p.rate).toBe("number");
    expect(await get("0")).toEqual(await get("25")); // non-positive → default
    expect(await get("1e9")).toEqual(h.sentinel.series("m|all", 1000));
    expect(await get("1")).toEqual(h.sentinel.series("m|all", 1));
  });

  it("POST /context updates the host context used by later probes", async () => {
    const h = makeHarness(tempDir());
    const base = await start(h);
    const res = await post(`${base}/context`, { modelId: "m2", kvPressure: 0.97, busy: true });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ modelId: "m2", kvPressure: 0.97, busy: true, checkpoint: "ckpt-1" });
    expect(h.host.current()).toMatchObject({ modelId: "m2", kvPressure: 0.97, busy: true });
    const r = (await h.sentinel.probeOnce())!;
    expect(r.host.modelId).toBe("m2");
    expect(r.stream.startsWith("m2|")).toBe(true);
  });

  it("POST /observe validates input and scores grounding", async () => {
    const h = makeHarness(tempDir());
    const base = await start(h);
    for (const bad of [{}, { answer: 1, sources: [] }, { answer: "x" }, { answer: "x", sources: "not an array" }]) {
      const res = await post(`${base}/observe`, bad);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: "answer (string) and sources (string[]) are required" });
    }
    const badJson = await post(`${base}/observe`, "{oops");
    expect(badJson.status).toBe(400);
    expect(await json(badJson)).toEqual({ error: "body must be a JSON object" });
    for (const body of ["[1]", "3", "null"]) {
      const r = await post(`${base}/observe`, body);
      expect(r.status).toBe(400);
      expect(await json(r)).toEqual({ error: "body must be a JSON object" });
    }

    const ok = await post(`${base}/observe`, { answer: "Fuel lasts 72 hours", sources: ["fuel autonomy 72 h"] });
    expect(await json(ok)).toMatchObject({ hallucinated: false, unsupported: [], stream: "m|live" });
    const unknown = await post(`${base}/observe`, { answer: "x", sources: [], host: { modelId: "edge" } });
    expect(unknown.status).toBe(400);
    expect(await json(unknown)).toEqual({ error: "unknown model edge; push it via /context first" });
    // The configured model is always accepted, and so is a model pushed via /context.
    expect((await post(`${base}/observe`, { answer: "1", sources: ["1"], host: { modelId: "m" } })).status).toBe(200);
    await post(`${base}/context`, { modelId: "edge" });
    const bad = await post(`${base}/observe`, { answer: "Fuel lasts 96 hours", sources: ["fuel autonomy 72 h"], id: "req-1", host: { modelId: "edge" } });
    expect(await json(bad)).toMatchObject({ hallucinated: true, unsupported: ["96"], stream: "edge|live" });
    expect(h.sentinel.allResults.map((r) => r.probeId)).toEqual(["live-0", "live-1", "live-2"]);
    expect(h.sentinel.allResults.at(-1)!.requestId).toBe("req-1");
  });

  it("requires the bearer token on every route when configured", async () => {
    const h = makeHarness(tempDir());
    const base = await start(h, "s3cret");
    for (const path of ["/status", "/episodes", "/series?stream=x", "/report"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(401);
      expect(await json(res)).toEqual({ error: "unauthorized" });
    }
    expect((await post(`${base}/context`, { busy: true })).status).toBe(401);
    expect(h.host.current().busy).toBe(false);
    expect((await fetch(`${base}/status`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/status`, { headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
  });

  it("POST requires content-type application/json (415)", async () => {
    const h = makeHarness(tempDir());
    const base = await start(h);
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await fetch(`${base}/context`, { method: "POST", headers: { "content-type": type }, body: JSON.stringify({ busy: true }) });
      expect(res.status).toBe(415);
      expect(await json(res)).toEqual({ error: "content-type must be application/json" });
    }
    expect((await fetch(`${base}/observe`, { method: "POST", body: "{}" })).status).toBe(415);
    expect(h.host.current().busy).toBe(false);
    const ok = await fetch(`${base}/context`, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ busy: true }) });
    expect(ok.status).toBe(200);
  });

  it("rejects non-loopback Host headers (403) unless allowed", async () => {
    const h = makeHarness(tempDir());
    const base = await start(h, undefined, ["sentinel.internal:7710"]);
    const port = new URL(base).port;
    const get = (hostHeader: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/status", headers: { host: hostHeader } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });
    for (const bad of ["evil.example", "evil.example:80", "127.0.0.1.evil.example", "sentinel.internal"]) {
      const r = await get(bad);
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body)).toEqual({ error: "host not allowed" });
    }
    for (const good of [`127.0.0.1:${port}`, "localhost", `LOCALHOST:${port}`, "[::1]:9", "sentinel.internal:7710"]) expect((await get(good)).status).toBe(200);
  });

  it("rejects oversize bodies (413)", async () => {
    const h = makeHarness(tempDir());
    const base = await start(h);
    const res = await post(`${base}/observe`, { answer: "x".repeat(2_100_000), sources: [] });
    expect(res.status).toBe(413);
    expect(await json(res)).toEqual({ error: "request too large" });
    expect(h.sentinel.allResults).toHaveLength(0);
  });

  it("/observe returns 429 when no stream can be created", async () => {
    const h = makeHarness(tempDir(), { maxStreams: 2, pools: undefined });
    await drive(h, 1); // m|400 + m|all
    const base = await start(h);
    const res = await post(`${base}/observe`, { answer: "1", sources: ["1"] });
    // canMonitor("m") is true (m already has streams), but m|live is past the cap: RangeError → 429.
    expect(res.status).toBe(429);
    expect(String((await json(res)).error)).toMatch(/stream limit/);
    // A new model past the cap is refused at /context, before anything is recorded…
    const ctx = await post(`${base}/context`, { modelId: "fresh" });
    expect(ctx.status).toBe(429);
    // …so it is still unknown to /observe.
    const fresh = await post(`${base}/observe`, { answer: "1", sources: ["1"], host: { modelId: "fresh" } });
    expect(fresh.status).toBe(400);
  });

  it("POST /context keeps only known, well-typed fields", async () => {
    const h = makeHarness(tempDir());
    const base = await start(h);
    const res = await post(`${base}/context`, { kvPressure: "high", gpuTempC: 71, busy: "yes", evil: 1, quantization: "q".repeat(300), extra: { fan: 1200, bad: "x" } });
    const ctx = await json(res);
    expect(ctx.gpuTempC).toBe(71);
    expect(ctx.kvPressure).toBe(h.opts.host.current().kvPressure);
    expect(ctx.busy).toBe(false);
    expect(ctx.evil).toBeUndefined();
    expect(ctx.quantization).toBe("q8_0");
    expect(ctx.extra).toEqual({ fan: 1200 });
  });
});

describe("cleanContext", () => {
  it("filters by name, type, finiteness and size", () => {
    expect(cleanContext({ modelId: "m", checkpoint: 3, quantization: "q4", kvPressure: 0.5, thermalDerate: Number.NaN, gpuTempC: Infinity, queueDepth: 2, busy: true, other: "x" })).toEqual({
      modelId: "m",
      quantization: "q4",
      kvPressure: 0.5,
      queueDepth: 2,
      busy: true,
    });
    expect(cleanContext({ modelId: "x".repeat(201) })).toEqual({});
    const extra = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(cleanContext({ extra }).extra!)).toHaveLength(32);
    expect(cleanContext({ extra: { ["k".repeat(65)]: 1, ok: 2 } }).extra).toEqual({ ok: 2 });
    expect(cleanContext({})).toEqual({});
  });
});
