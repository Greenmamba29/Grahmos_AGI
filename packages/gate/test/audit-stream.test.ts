import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, ChainVerifier, forEachLine, GENESIS, verifyAuditLog, type AuditEntry } from "../src/audit.js";

const dir = () => mkdtempSync(join(tmpdir(), "gate-audit-stream-"));
const fixedNow = () => new Date("2026-10-09T00:00:00Z");

function lines(path: string, chunk?: number): { line: string; complete: boolean; offset: number }[] {
  const out: { line: string; complete: boolean; offset: number }[] = [];
  forEachLine(path, (line, complete, offset) => out.push({ line, complete, offset }), chunk);
  return out;
}

describe("forEachLine", () => {
  it("yields complete lines with byte offsets, across chunk boundaries and multibyte characters", () => {
    const p = join(dir(), "f.jsonl");
    const text = "alpha\nßéta — ünïcödé ✓\n\ngamma🙂\n";
    writeFileSync(p, text);
    for (const chunk of [1, 2, 3, 5, 7, 1 << 20]) {
      const got = lines(p, chunk);
      expect(got.map((l) => l.line)).toEqual(["alpha", "ßéta — ünïcödé ✓", "", "gamma🙂"]);
      expect(got.every((l) => l.complete)).toBe(true);
      const buf = Buffer.from(text);
      for (const l of got) expect(buf.subarray(l.offset, l.offset + Buffer.byteLength(l.line)).toString()).toBe(l.line);
    }
  });

  it("reports a torn last line as incomplete", () => {
    const p = join(dir(), "f.jsonl");
    writeFileSync(p, 'one\n{"half":');
    for (const chunk of [2, 64]) {
      const got = lines(p, chunk);
      expect(got).toEqual([
        { line: "one", complete: true, offset: 0 },
        { line: '{"half":', complete: false, offset: 4 },
      ]);
    }
  });

  it("handles an empty file", () => {
    const p = join(dir(), "empty");
    writeFileSync(p, "");
    expect(lines(p)).toEqual([]);
  });
});

describe("ChainVerifier", () => {
  const build = (key?: string) => {
    const log = new AuditLog({ hmacKey: key, now: fixedNow });
    log.append("a", { x: 1 });
    log.append("b", { y: [1, 2] });
    log.append("c", null);
    return log;
  };

  it("verifies line by line and agrees with verifyAuditLog", () => {
    const log = build("k");
    const v = new ChainVerifier("k");
    const pushed = log.toJSONL().trim().split("\n").map((l) => v.push(l));
    expect(pushed.map((e) => e?.type)).toEqual(["a", "b", "c"]);
    expect(v.result()).toEqual(verifyAuditLog(log.toJSONL(), "k"));
    expect(v.result()).toMatchObject({ ok: true, count: 3, head: log.head, lastType: "c" });
  });

  it("starts at genesis", () => {
    expect(new ChainVerifier().result()).toEqual({ ok: true, count: 0, head: GENESIS, lastType: undefined });
  });

  it("stops at the first bad line and stays failed", () => {
    const ls = build().toJSONL().trim().split("\n");
    const e = JSON.parse(ls[1]!) as AuditEntry;
    ls[1] = JSON.stringify({ ...e, payload: { y: [9] } });
    const v = new ChainVerifier();
    expect(v.push(ls[0]!)).toBeDefined();
    expect(v.push(ls[1]!)).toBeUndefined();
    expect(v.push(ls[2]!)).toBeUndefined();
    expect(v.result()).toMatchObject({ ok: false, count: 1, brokenAt: 1 });
    expect(v.result().reason).toMatch(/hash mismatch at entry 1/);
  });

  it("rejects invalid JSON, wrong seq and a wrong key", () => {
    const ls = build("k").toJSONL().trim().split("\n");
    const bad = new ChainVerifier("k");
    expect(bad.push("{not json")).toBeUndefined();
    expect(bad.result().reason).toBe("line 1 is not valid JSON");
    const skip = new ChainVerifier("k");
    skip.push(ls[0]!);
    expect(skip.push(ls[2]!)).toBeUndefined();
    expect(skip.result().reason).toBe("expected seq 1, found 2");
    const wrongKey = new ChainVerifier("other");
    expect(wrongKey.push(ls[0]!)).toBeUndefined();
    expect(wrongKey.result().reason).toMatch(/wrong key/);
  });
});

describe("AuditLog retain / count / resume", () => {
  it("retain:false keeps no entries in memory but tracks count and head", () => {
    const kept = new AuditLog({ now: fixedNow });
    const lean = new AuditLog({ now: fixedNow, retain: false });
    for (const l of [kept, lean]) {
      l.append("a", 1);
      l.append("b", 2);
    }
    expect(lean.entries).toEqual([]);
    expect(lean.count).toBe(2);
    expect(kept.count).toBe(2);
    expect(lean.head).toBe(kept.head);
    expect(lean.toJSONL()).toBe("");
  });

  it("resume streams entries to onEntry and continues the chain", () => {
    const p = join(dir(), "audit.jsonl");
    const a = new AuditLog({ filePath: p, hmacKey: "k", now: fixedNow });
    a.append("x", { i: 0 });
    a.append("y", { i: 1 });
    const seen: string[] = [];
    const b = AuditLog.resume({ filePath: p, hmacKey: "k", now: fixedNow, retain: false, onEntry: (e) => seen.push(`${e.seq}:${e.type}`) });
    expect(seen).toEqual(["0:x", "1:y"]);
    expect(b.entries).toEqual([]);
    expect(b.count).toBe(2);
    expect(b.head).toBe(a.head);
    expect(b.append("z", {}).seq).toBe(2);
    const v = verifyAuditLog(readFileSync(p, "utf8"), "k");
    expect(v).toMatchObject({ ok: true, count: 3, lastType: "z" });

    const c = AuditLog.resume({ filePath: p, hmacKey: "k" });
    expect(c.entries.map((e) => e.type)).toEqual(["x", "y", "z"]);
    expect(c.count).toBe(3);
  });

  it("resume on a missing file starts a fresh chain", () => {
    const l = AuditLog.resume({ filePath: join(dir(), "nope", "audit.jsonl") });
    expect(l.count).toBe(0);
    expect(l.head).toBe(GENESIS);
  });

  it("resume throws on a torn last line and on a broken chain", () => {
    const p = join(dir(), "audit.jsonl");
    const a = new AuditLog({ filePath: p, now: fixedNow });
    a.append("x", 1);
    appendFileSync(p, '{"seq":1,"ts":"2026');
    expect(() => AuditLog.resume({ filePath: p })).toThrow(/last line is incomplete \(torn write\)/);

    const q = join(dir(), "audit.jsonl");
    const b = new AuditLog({ filePath: q, now: fixedNow });
    b.append("x", 1);
    b.append("y", 2);
    const ls = readFileSync(q, "utf8").trim().split("\n");
    writeFileSync(q, `${ls[1]}\n${ls[0]}\n`);
    expect(() => AuditLog.resume({ filePath: q })).toThrow(/cannot resume .*expected seq 0, found 1/);
  });

  it("resume ignores blank lines", () => {
    const p = join(dir(), "audit.jsonl");
    const a = new AuditLog({ filePath: p, now: fixedNow });
    a.append("x", 1);
    appendFileSync(p, "\n\n");
    expect(AuditLog.resume({ filePath: p }).count).toBe(1);
  });
});
