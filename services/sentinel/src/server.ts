import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { renderReport } from "./report.js";
import type { PushedHostContext, Sentinel } from "./sentinel.js";
import type { HostContext } from "./types.js";

/**
 * Sentinel's local HTTP API (bind to 127.0.0.1; the orchestrator proxies it).
 *   GET  /status                   streams, baselines, CUSUM statistics, open episodes
 *   GET  /episodes                 all episodes with onset/end, rates, attribution
 *   GET  /series?stream=…&window=  rolling rate for the console chart
 *   GET  /report                   self-contained HTML report
 *   POST /context  {HostContext}   orchestrator pushes host telemetry (model swap, KV, thermal, busy)
 *   POST /observe  {answer, sources[], host?, id?}   live-traffic grounding check
 *
 * Hardening: POST bodies must be application/json (blocks form posts from a
 * browser page); the Host header must be loopback unless `allowedHosts` says
 * otherwise (blocks DNS rebinding); the bearer token is compared in constant
 * time; oversize bodies are cut off.
 */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const MAX_BODY = 2_000_000;
const NUMERIC_CONTEXT = ["kvPressure", "thermalDerate", "gpuTempC", "queueDepth"] as const;
const STRING_CONTEXT = ["modelId", "checkpoint", "quantization"] as const;

class HttpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function tokenOk(header: string | undefined, token: string): boolean {
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Keeps only known HostContext fields with the right types. */
export function cleanContext(b: Record<string, unknown>): Partial<HostContext> {
  const out: Partial<HostContext> = {};
  for (const k of STRING_CONTEXT) if (typeof b[k] === "string" && (b[k] as string).length <= 200) out[k] = b[k] as string;
  for (const k of NUMERIC_CONTEXT) if (typeof b[k] === "number" && Number.isFinite(b[k])) out[k] = b[k] as number;
  if (typeof b.busy === "boolean") out.busy = b.busy;
  if (b.extra && typeof b.extra === "object") {
    const extra: Record<string, number> = {};
    for (const [k, v] of Object.entries(b.extra as Record<string, unknown>).slice(0, 32)) if (typeof v === "number" && Number.isFinite(v) && k.length <= 64) extra[k] = v;
    out.extra = extra;
  }
  return out;
}

export function serveSentinel(s: Sentinel, host: PushedHostContext, opts: { token?: string; allowedHosts?: string[] } = {}): Server {
  const send = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : String(body));
  };
  const read = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return reject(new HttpError(415, "content-type must be application/json"));
      if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return reject(new HttpError(413, "request too large"));
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, "request too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("error", reject);
      req.on("end", () => {
        try {
          const v: unknown = size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
          if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
          resolve(v as Record<string, unknown>);
        } catch {
          reject(new HttpError(400, "body must be a JSON object"));
        }
      });
    });
  return createServer(async (req, res) => {
    try {
      const h = req.headers.host ?? "";
      if (!(LOOPBACK.test(h) || opts.allowedHosts?.includes(h))) return send(res, 403, { error: "host not allowed" });
      if (opts.token && !tokenOk(req.headers.authorization, opts.token)) return send(res, 401, { error: "unauthorized" });
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/status") return send(res, 200, s.status());
      if (req.method === "GET" && url.pathname === "/episodes") return send(res, 200, { episodes: s.episodes() });
      if (req.method === "GET" && url.pathname === "/series") {
        const stream = url.searchParams.get("stream") ?? "";
        const window = Math.min(1000, Math.max(1, Math.floor(Number(url.searchParams.get("window") ?? 25)) || 25));
        return send(res, 200, { stream, series: s.series(stream, window) });
      }
      if (req.method === "GET" && url.pathname === "/report") return send(res, 200, renderReport(s), "text/html; charset=utf-8");
      if (req.method === "POST" && url.pathname === "/context") {
        const ctx = cleanContext(await read(req));
        if (ctx.modelId && !s.canMonitor(ctx.modelId)) return send(res, 429, { error: "stream limit reached; cannot monitor another model" });
        return send(res, 200, host.push(ctx));
      }
      if (req.method === "POST" && url.pathname === "/observe") {
        const b = await read(req);
        if (typeof b.answer !== "string" || !Array.isArray(b.sources)) return send(res, 400, { error: "answer (string) and sources (string[]) are required" });
        const hostOverride = b.host && typeof b.host === "object" ? cleanContext(b.host as Record<string, unknown>) : undefined;
        const model = hostOverride?.modelId ?? host.current().modelId;
        // Only the model Sentinel is configured for, or one the orchestrator has pushed, gets a stream.
        if (hostOverride?.modelId && hostOverride.modelId !== host.current().modelId && hostOverride.modelId !== s.modelName) return send(res, 400, { error: `unknown model ${model}; push it via /context first` });
        if (!s.canMonitor(model)) return send(res, 429, { error: "stream limit reached" });
        const id = typeof b.id === "string" && b.id.length <= 200 ? b.id : undefined;
        const r = await s.observe({ answer: b.answer, sources: b.sources.map(String), host: hostOverride, id });
        return send(res, 200, { id: r.result.probeId, hallucinated: r.result.hallucinated, unsupported: r.unsupported, stream: r.result.stream });
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) send(res, e instanceof HttpError ? e.code : e instanceof RangeError ? 429 : 400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}
