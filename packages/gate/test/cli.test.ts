import { execFile } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import type { RunRecord } from "../src/types.js";
import { tempDir } from "./helpers.js";

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

async function gate(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(TSX, ["bin/gate.ts", ...args], { cwd: ROOT, timeout: 30_000, env: { ...process.env, GATE_AUDIT_KEY: "", ...env } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    if (err.killed) throw new Error("gate CLI timed out");
    return { code: typeof err.code === "number" ? err.code : -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("CLI smoke", { timeout: 60_000 }, () => {
  let runDir: string;
  let runResult: { code: number; stdout: string; stderr: string };

  beforeAll(async () => {
    runDir = join(tempDir("gate-cli-run-"), "out");
    runResult = await gate(["run", "--agent", "sim:frontier", "--repeats", "2", "--bootstrap", "20", "--out", runDir], { GATE_AUDIT_KEY: "clikey" });
  }, 60_000);

  it("self-test passes on the example suite", async () => {
    const r = await gate(["self-test"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("self-test passed: 16 tasks");
  });

  it("list-tasks prints every task", async () => {
    const r = await gate(["list-tasks"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(16);
    expect(lines[0]).toMatch(/^sales-total\s+2\.0m\s+low/);
    expect(r.stdout).toMatch(/redact-notes.*holdout/);
    expect(r.stdout).toMatch(/sla-breach-audit\s+8\.0h\s+high/);
    expect(lines.at(-1)).toMatch(/^budget-consolidation\s+16h\s+high/);
  });

  it("run writes a verifiable output folder and prints the final head", () => {
    expect(runResult.code).toBe(0);
    expect(runResult.stdout).toMatch(/^sim:frontier\s+h50/m);
    expect(runResult.stdout).toMatch(/gates S0:(pass|fail|insufficient) S1:(pass|fail|insufficient) S2-proxy:(pass|fail|insufficient)/);
    expect(runResult.stdout).toMatch(/^Final audit head \(anchor this somewhere you control\): [0-9a-f]{64}$/m);
    expect(runResult.stdout).toContain(`Check the folder with: gate verify ${runDir} --require-hmac --expect-head `);
  });

  const head = () => /Final audit head[^:]*: ([0-9a-f]{64})/.exec(runResult.stdout)![1]!;

  it("verify <dir> --recompute --require-hmac --expect-head is OK and lists what it checked", async () => {
    const r = await gate(["verify", runDir, "--recompute", "--require-hmac", "--expect-head", head()], { GATE_AUDIT_KEY: "clikey" });
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("OK");
    expect(lines).toContain("    · sealed hashes of results.json, report.md, report.html");
    expect(lines).toContain("    · 32 run transcripts and outcomes against the log");
    expect(lines).toContain("    · records digest");
    expect(lines).toContain("    · recomputed metrics and gate verdicts for 1 agent(s)");
    expect(lines.some((l) => /^    · audit chain \(\d+ entries, HMAC\) ends with the artifacts seal$/.test(l))).toBe(true);
    expect(lines.at(-1)).toBe(`  head ${head()}`);
    expect(r.stdout).not.toContain("WARNING");
  });

  it("verify <dir> without the key fails; with the key but no --expect-head there is no warning and exit 0", async () => {
    const noKey = await gate(["verify", runDir]);
    expect(noKey.code).toBe(1);
    expect(noKey.stdout).toMatch(/^FAILED\n  checks run:\n  problems:\n    ✗ hash mismatch at entry 0/);
    const keyed = await gate(["verify", runDir], { GATE_AUDIT_KEY: "clikey" });
    expect(keyed.code).toBe(0);
    expect(keyed.stdout).not.toContain("WARNING");
  });

  it("verify <dir> FAILED after editing results.json", async () => {
    const d = tempDir("gate-cli-tamper-");
    cpSync(runDir, d, { recursive: true });
    const p = join(d, "results.json");
    const v = JSON.parse(readFileSync(p, "utf8")) as { records: RunRecord[] };
    const rec = v.records[0]!;
    rec.naivePass = !rec.naivePass;
    writeFileSync(p, JSON.stringify(v, null, 2));
    const r = await gate(["verify", d], { GATE_AUDIT_KEY: "clikey" });
    expect(r.code).toBe(1);
    expect(r.stdout.split("\n")[0]).toBe("FAILED");
    expect(r.stdout).toContain("    ✗ results.json does not match the hash sealed in the audit log");
    expect(r.stdout).toContain(`    ✗ run ${rec.runId}: naivePass is ${rec.naivePass} in results.json`);
    expect(r.stdout).toContain("    · audit chain");
    expect(r.stdout).not.toMatch(/^  head /m);
  });

  it("unkeyed verify <dir>: exit 1 'NOT CERTIFIED' without --expect-head; 0 with --allow-unkeyed or --expect-head", async () => {
    const d = join(tempDir("gate-cli-unkeyed-"), "out");
    const run = await gate(["run", "--agent", "sim:honest-junior", "--repeats", "1", "--bootstrap", "5", "--out", d]);
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain("--require-hmac");
    const h = /Final audit head[^:]*: ([0-9a-f]{64})/.exec(run.stdout)![1]!;

    const bare = await gate(["verify", d]);
    expect(bare.code).toBe(1);
    expect(bare.stdout.split("\n")[0]).toBe("OK"); // the evidence is consistent…
    expect(bare.stdout).toMatch(/· audit chain \(\d+ entries, unkeyed\) ends with the artifacts seal/);
    expect(bare.stdout).toContain("NOT CERTIFIED: unkeyed check with no --expect-head."); // …but not certified
    expect(bare.stdout).toContain("or pass --allow-unkeyed to accept a consistency-only check.");

    const allowed = await gate(["verify", d, "--allow-unkeyed"]);
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toContain("WARNING: unkeyed check with no --expect-head.");
    expect(allowed.stdout).not.toContain("NOT CERTIFIED");

    const anchored = await gate(["verify", d, "--expect-head", h]);
    expect(anchored.code).toBe(0);
    expect(anchored.stdout).not.toMatch(/WARNING|NOT CERTIFIED/);

    const wrong = await gate(["verify", d, "--expect-head", "0".repeat(64)]);
    expect(wrong.code).toBe(1);
    expect(wrong.stdout).toContain("does not match the expected head");
    const hmacRequired = await gate(["verify", d, "--require-hmac"]);
    expect(hmacRequired.code).toBe(1);
    expect(hmacRequired.stdout).toContain("✗ an HMAC key is required to verify this log");

    // file form on the sealed log: removing the artifacts line fails without --allow-partial
    const lines = readFileSync(join(d, "audit.jsonl"), "utf8").trimEnd().split("\n");
    const cut = join(d, "cut.jsonl");
    writeFileSync(cut, lines.slice(0, -1).join("\n") + "\n");
    const c1 = await gate(["verify", cut, "--expect-head", h]);
    expect(c1.code).toBe(1);
    expect(c1.stdout.trim()).toBe('BROKEN: log ends with "evaluation_end", expected artifacts: it may be truncated');
    const c2 = await gate(["verify", cut, "--allow-partial", "--allow-unkeyed"]);
    expect(c2.code).toBe(0);
    expect(c2.stdout).toContain('last entry "evaluation_end" (partial log accepted)');
    const full = await gate(["verify", join(d, "audit.jsonl"), "--expect-head", h]);
    expect(full.code).toBe(0);
    expect(full.stdout).toContain(`OK: ${lines.length} entries, head ${h}, last entry "artifacts"`);
  });

  it("verify <file> on an unsealed log: requires evaluation_end unless --allow-partial", async () => {
    const dir = tempDir("gate-cli-");
    const log = new AuditLog();
    log.append("evaluation_start", { sealed: false });
    for (let i = 0; i < 3; i++) log.append("run", { i });
    log.append("evaluation_end", {});
    const good = join(dir, "good.jsonl");
    writeFileSync(good, log.toJSONL());

    const ok = await gate(["verify", good, "--allow-unkeyed"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain(`OK: 5 entries, head ${log.head}, last entry "evaluation_end"`);
    const notCert = await gate(["verify", good]);
    expect(notCert.code).toBe(1);
    expect(notCert.stdout).toContain("NOT CERTIFIED");

    const truncated = join(dir, "truncated.jsonl");
    writeFileSync(truncated, log.toJSONL().split("\n").slice(0, 3).join("\n") + "\n");
    const t = await gate(["verify", truncated, "--allow-unkeyed"]);
    expect(t.code).toBe(1);
    expect(t.stdout.trim()).toBe('BROKEN: log ends with "run", expected evaluation_end or artifacts: it may be truncated');
    const partial = await gate(["verify", truncated, "--allow-partial", "--allow-unkeyed"]);
    expect(partial.code).toBe(0);
    expect(partial.stdout).toContain('OK: 3 entries');

    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, readFileSync(good, "utf8").replace('"i":2', '"i":3'));
    const broken = await gate(["verify", bad, "--allow-unkeyed"]);
    expect(broken.code).toBe(1);
    expect(broken.stdout).toContain("BROKEN at entry 3: hash mismatch");
  });

  it("calibrate smoke: --sims 2 prints a table", async () => {
    const r = await gate(["calibrate", "--sims", "2", "--repeats", "2", "--bootstrap", "5", "--multiples", "0.5,4"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe("Calibration of S1 (horizon requirement) on the synthetic calibration suite (no task-to-task variation: a best case)");
    expect(lines[1]).toBe("true horizon         pass   insufficient   fail");
    expect(lines[2]).toMatch(/^0\.5× \(4\.0h\)\s+\d+\.\d%\s+\d+\.\d%\s+\d+\.\d%$/);
    expect(lines[3]).toMatch(/^4× \(32h\)\s+/);
    expect(lines.at(-1)).toContain("PASS at ≤ 1× is the false-pass rate");
    const bad = await gate(["calibrate", "--gate", "S9", "--sims", "1"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("error: unknown gate S9; built-in gates: S0, S1, S2-proxy");
    const badM = await gate(["calibrate", "--multiples", "1,x", "--sims", "1"]);
    expect(badM.code).toBe(1);
    expect(badM.stderr).toContain("--multiples must be positive numbers");
  });

  it("--repeats abc exits 1 with a clear message", async () => {
    const r = await gate(["run", "--agent", "sim:frontier", "--repeats", "abc", "--out", join(tempDir(), "x")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('error: --repeats must be an integer ≥ 1, got "abc"');
  });

  it("an invalid --gates file exits 1 with the validation error", async () => {
    const dir = tempDir("gate-cli-gates-");
    const gates = join(dir, "gates.json");
    writeFileSync(gates, JSON.stringify([{ id: "X", name: "x", requirements: [{ metric: "speed", op: ">=", value: 1 }] }]));
    const r = await gate(["run", "--agent", "sim:frontier", "--repeats", "1", "--gates", gates, "--out", join(dir, "out")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('error: gates[0].requirements[0].metric "speed" is not one of');
    writeFileSync(gates, "{not json");
    const r2 = await gate(["run", "--agent", "sim:frontier", "--repeats", "1", "--gates", gates, "--out", join(dir, "out")]);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toMatch(/^error: .*JSON/m);
  });

  it("unknown command prints help and exits 1; help exits 0", async () => {
    const r = await gate(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("gate — Gated Agent Trust Evaluation");
    const h = await gate(["help"]);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("Usage:");
  });

  it("verify without a target reports a usage error", async () => {
    const r = await gate(["verify"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: gate verify <output-dir | audit.jsonl>");
  });
});
