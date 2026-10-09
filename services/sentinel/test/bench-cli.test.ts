import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { verifyAuditLog } from "@grahmos/gate";
import { benchDetection } from "../src/bench.js";
import { hostAt, SCENARIO, SCENARIO_LENGTH, scenarioRate } from "../src/scenario.js";
import { generateProbe } from "../src/probes.js";
import { tempDir } from "./helpers.js";

const run = promisify(execFile);
const PKG = resolve(import.meta.dirname, "..");
const TSX = join(PKG, "node_modules", ".bin", "tsx");

async function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const clean = { ...process.env };
  delete clean.SENTINEL_POOL_SALT;
  try {
    const r = await run(TSX, ["bin/sentinel.ts", ...args], { cwd: PKG, env: { ...clean, ...env }, timeout: 60_000 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("scenario", () => {
  it("host context and rates follow the documented regimes", () => {
    expect(SCENARIO_LENGTH).toBe(2000);
    expect(SCENARIO.map((r) => [r.from, r.to])).toEqual([
      [600, 900],
      [1300, 1600],
    ]);
    expect(hostAt(100).quantization).toBe("q8_0");
    expect(hostAt(700).quantization).toBe("q4_k_m");
    expect(hostAt(700).thermalDerate!).toBeGreaterThan(0.3);
    expect(hostAt(1400).kvPressure!).toBeGreaterThan(0.9);
    expect(hostAt(0, "x").modelId).toBe("x");
    let i = 0;
    const rate = scenarioRate(() => i);
    const p1k = { ...generateProbe(1, 0, { bands: [1000] }), band: 1000 };
    const p32k = { ...p1k, band: 32000 };
    expect(rate(p1k)).toBe(0.02);
    expect(rate(p32k)).toBe(0.04);
    i = 700;
    expect(rate(p1k)).toBeCloseTo(0.12);
    i = 1400;
    expect(rate(p1k)).toBe(0.02);
    expect(rate(p32k)).toBe(0.45);
  });
});

describe("benchDetection", () => {
  it("returns a sane structure for one seed", async () => {
    const r = await benchDetection({ seeds: 1 });
    expect(r.seeds).toBe(1);
    expect(r.windows).toBe(7); // 2 windows on |all; 1 per band stream (4) for thermal; 1 extra on 32k for KV
    expect(r.misses).toBeGreaterThanOrEqual(0);
    expect(r.misses).toBeLessThan(r.windows);
    expect(Object.values(r.missesByStream).reduce((a, b) => a + b, 0)).toBe(r.misses);
    expect(r.fragments).toBeGreaterThanOrEqual(0);
    expect(r.falseAlarms).toBeGreaterThanOrEqual(0);
    for (const v of [r.onsetError.median, r.onsetError.mae, r.endError.median, r.endError.mae, r.delay.median, r.delay.p90]) expect(Number.isFinite(v)).toBe(true);
    expect(r.delay.median).toBeGreaterThanOrEqual(0);
    expect(r.delay.p90).toBeGreaterThanOrEqual(r.delay.median);
    expect(r.onsetError.mae).toBeLessThan(300);
    expect(r.details).toHaveLength(r.windows);
    for (const d of r.details) {
      expect(d.seed).toBe(1);
      expect(["m|all", "m|1k", "m|4k", "m|16k", "m|32k"]).toContain(d.stream);
      expect(d.to).toBeGreaterThan(d.from);
      if (d.parts === 0) expect(d.onset).toBeUndefined();
      else expect(d.end! > d.onset!).toBe(true);
    }
    expect(r.details.filter((d) => d.parts === 0)).toHaveLength(r.misses);
  }, 30_000);
});

describe("CLI", () => {
  it("help prints usage and exits 0; unknown commands exit 1", async () => {
    const h = await cli(["help"]);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("sentinel — continuous hallucination monitor");
    for (const cmd of ["run", "demo", "bench", "report", "vault", "pairs"]) expect(h.stdout).toContain(`sentinel ${cmd}`);
    const bad = await cli(["frobnicate"]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("sentinel — continuous hallucination monitor");
  }, 60_000);

  it("pairs without SENTINEL_POOL_SALT exits 1 with a clear error", async () => {
    const r = await cli(["pairs", "--data", tempDir(), "--out", join(tempDir(), "p.jsonl")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("SENTINEL_POOL_SALT is required");
  }, 60_000);

  it("report without --data exits 1", async () => {
    const r = await cli(["report"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--data is required");
  }, 60_000);

  it("demo writes a report, vault, pairs and a valid audit chain; report/vault/pairs work on its data", async () => {
    const out = join(tempDir(), "demo");
    const r = await cli(["demo", "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Ground truth:");
    expect(r.stdout).toContain("Detected episodes");
    const html = readFileSync(join(out, "report.html"), "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Sentinel demo");
    expect(existsSync(join(out, "vault", "Episodes"))).toBe(true);
    expect(existsSync(join(out, "preference-pairs.jsonl"))).toBe(true);
    expect(readFileSync(join(out, "events.jsonl"), "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(SCENARIO_LENGTH);
    expect(verifyAuditLog(readFileSync(join(out, "data", "audit.jsonl"), "utf8")).ok).toBe(true);

    const reportOut = join(out, "again.html");
    expect((await cli(["report", "--data", join(out, "data"), "--out", reportOut])).code).toBe(0);
    expect(readFileSync(reportOut, "utf8")).toContain("<svg");

    const v = await cli(["vault", "--data", join(out, "data"), "--out", join(out, "vault2")]);
    expect(v.code).toBe(0);
    expect(v.stdout).toMatch(/wrote \d+ notes/);

    const pairsOut = join(out, "pairs.jsonl");
    const p = await cli(["pairs", "--data", join(out, "data"), "--out", pairsOut], { SENTINEL_POOL_SALT: "demo-salt-not-secret-0001" });
    expect(p.code).toBe(0);
    expect(p.stdout).toMatch(/wrote \d+ pairs \(0 skipped\)/);
    // Regression: `pairs` used to regenerate prompts with the wrong seed. Now identical to what the demo wrote.
    expect(readFileSync(pairsOut, "utf8")).toBe(readFileSync(join(out, "preference-pairs.jsonl"), "utf8"));
  }, 60_000);
});
