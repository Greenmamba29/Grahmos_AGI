import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, GENESIS, verifyAuditLog, type AuditEntry } from "../src/audit.js";
import { canonicalJSON, sha256 } from "../src/util.js";
import { tempDir } from "./helpers.js";

function fixedClock(): () => Date {
  let t = Date.UTC(2026, 0, 1);
  return () => new Date((t += 1000));
}

function build(n = 5, hmacKey?: string): AuditLog {
  const log = new AuditLog({ hmacKey, now: fixedClock() });
  for (let i = 0; i < n; i++) log.append(i % 2 ? "run" : "event", { i, nested: { b: [1, 2], a: "x" } });
  return log;
}
const lines = (jsonl: string) => jsonl.trimEnd().split("\n");
const join_ = (ls: string[]) => ls.join("\n") + "\n";

describe("AuditLog", () => {
  it("starts at GENESIS and chains entries", () => {
    const log = new AuditLog({ now: fixedClock() });
    expect(log.head).toBe(GENESIS);
    expect(log.toJSONL()).toBe("");
    const e0 = log.append("a", { x: 1 });
    const e1 = log.append("b", undefined);
    expect(e0.seq).toBe(0);
    expect(e0.prevHash).toBe(GENESIS);
    expect(e1.prevHash).toBe(e0.hash);
    expect(e1.payload).toBeNull();
    expect(log.head).toBe(e1.hash);
    expect(e0.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e0.ts).toBe("2026-01-01T00:00:01.000Z");
  });

  it("snapshots the payload at append time", () => {
    const log = new AuditLog({ now: fixedClock() });
    const payload = { n: 1, d: new Date(0) };
    log.append("a", payload);
    payload.n = 2;
    expect(log.entries[0]!.payload).toEqual({ n: 1, d: "1970-01-01T00:00:00.000Z" });
    expect(verifyAuditLog(log.toJSONL()).ok).toBe(true);
  });

  it("is deterministic given a clock", () => {
    expect(build(4).toJSONL()).toBe(build(4).toJSONL());
  });
});

describe("verifyAuditLog", () => {
  it("round-trips an unkeyed log", () => {
    const log = build();
    const r = verifyAuditLog(log.toJSONL());
    expect(r).toEqual({ ok: true, count: 5, head: log.head, lastType: "event" });
  });

  it("verifies an empty log with head = GENESIS", () => {
    expect(verifyAuditLog("")).toEqual({ ok: true, count: 0, head: GENESIS, lastType: undefined });
  });

  it("round-trips an HMAC log only with the right key", () => {
    const log = build(5, "secret");
    expect(verifyAuditLog(log.toJSONL(), "secret").ok).toBe(true);
    const wrong = verifyAuditLog(log.toJSONL(), "other");
    expect(wrong.ok).toBe(false);
    expect(wrong.brokenAt).toBe(0);
    expect(wrong.reason).toMatch(/hash mismatch.*wrong key/);
    expect(verifyAuditLog(log.toJSONL()).ok).toBe(false); // keyed log, verified unkeyed
    expect(verifyAuditLog(build(5).toJSONL(), "secret").ok).toBe(false); // unkeyed log, verified keyed
  });

  it("HMAC and unkeyed chains differ for identical content", () => {
    expect(build(3, "k").head).not.toBe(build(3).head);
  });

  it("detects an edited payload", () => {
    const ls = lines(build().toJSONL());
    const e = JSON.parse(ls[2]!) as AuditEntry;
    (e.payload as { i: number }).i = 99;
    ls[2] = JSON.stringify(e);
    const r = verifyAuditLog(join_(ls));
    expect(r).toMatchObject({ ok: false, brokenAt: 2, count: 2 });
    expect(r.reason).toMatch(/hash mismatch at entry 2/);
  });

  it("detects an edited type or timestamp", () => {
    for (const field of ["type", "ts"] as const) {
      const ls = lines(build().toJSONL());
      const e = JSON.parse(ls[1]!) as AuditEntry;
      e[field] = field === "ts" ? "2030-01-01T00:00:00.000Z" : "forged";
      ls[1] = JSON.stringify(e);
      expect(verifyAuditLog(join_(ls)).brokenAt).toBe(1);
    }
  });

  it("detects an edit whose hash was recomputed without the key (unkeyed rebuild can't fool HMAC)", () => {
    const ls = lines(build(3, "k").toJSONL());
    const e = JSON.parse(ls[2]!) as AuditEntry;
    e.payload = { forged: true };
    e.hash = sha256(`${e.prevHash}\n${canonicalJSON({ seq: e.seq, ts: e.ts, type: e.type, payload: e.payload })}`);
    ls[2] = JSON.stringify(e);
    expect(verifyAuditLog(join_(ls), "k").ok).toBe(false);
    // ...whereas an unkeyed log CAN be rebuilt by anyone (documented property of the unkeyed mode)
    const u = lines(build(3).toJSONL());
    const ue = JSON.parse(u[2]!) as AuditEntry;
    ue.payload = { forged: true };
    ue.hash = sha256(`${ue.prevHash}\n${canonicalJSON({ seq: ue.seq, ts: ue.ts, type: ue.type, payload: ue.payload })}`);
    u[2] = JSON.stringify(ue);
    expect(verifyAuditLog(join_(u)).ok).toBe(true);
  });

  it("detects a deleted line", () => {
    const ls = lines(build().toJSONL());
    ls.splice(1, 1);
    const r = verifyAuditLog(join_(ls));
    expect(r).toMatchObject({ ok: false, brokenAt: 1 });
    expect(r.reason).toBe("expected seq 1, found 2");
  });

  it("detects reordered lines", () => {
    const ls = lines(build().toJSONL());
    [ls[1], ls[2]] = [ls[2]!, ls[1]!];
    expect(verifyAuditLog(join_(ls))).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it("detects an inserted line even with a correct seq and hash for its own content", () => {
    const log = build(3);
    const ls = lines(log.toJSONL());
    // forge an entry claiming seq 1, chained to entry 0
    const forger = new AuditLog({ now: fixedClock() });
    forger.append("event", JSON.parse(ls[0]!).payload);
    const fake = forger.append("forged", { evil: true });
    ls.splice(1, 0, JSON.stringify(fake));
    const r = verifyAuditLog(join_(ls));
    expect(r.ok).toBe(false);
    expect(r.brokenAt).toBeGreaterThanOrEqual(1);
  });

  it("detects a renumbered chain (seq fixed up after deletion)", () => {
    const ls = lines(build().toJSONL());
    ls.splice(1, 1);
    for (let i = 1; i < ls.length; i++) {
      const e = JSON.parse(ls[i]!) as AuditEntry;
      e.seq = i;
      ls[i] = JSON.stringify(e);
    }
    const r = verifyAuditLog(join_(ls));
    expect(r).toMatchObject({ ok: false, brokenAt: 1, reason: "prevHash does not match entry 0" });
  });

  it("KNOWN PROPERTY: a truncated tail still verifies without options (use requireLastType / expectHead)", () => {
    const log = build(5);
    const ls = lines(log.toJSONL());
    const r = verifyAuditLog(join_(ls.slice(0, 3)));
    expect(r.ok).toBe(true);
    expect(r.count).toBe(3);
    expect(r.head).not.toBe(log.head); // only the head reveals the truncation
    expect(r.head).toBe(log.entries[2]!.hash);
  });

  it("reports invalid JSON with a 1-based line number", () => {
    const ls = lines(build(3).toJSONL());
    ls[1] = "{not json";
    expect(verifyAuditLog(join_(ls))).toMatchObject({ ok: false, brokenAt: 1, count: 1, reason: "line 2 is not valid JSON" });
  });

  it("ignores blank lines and CRLF-free trailing newlines", () => {
    const jsonl = build(3).toJSONL();
    expect(verifyAuditLog(`\n${jsonl.replace(/\n/g, "\n\n")}  \n`).ok).toBe(true);
  });
});

describe("AuditLog file persistence", () => {
  it("appends each entry to filePath as it is written, creating parent dirs", () => {
    const dir = tempDir();
    const filePath = join(dir, "nested", "deeper", "audit.jsonl");
    const log = new AuditLog({ filePath, hmacKey: "k", now: fixedClock() });
    log.append("a", { x: 1 });
    expect(readFileSync(filePath, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    log.append("b", { y: 2 });
    const content = readFileSync(filePath, "utf8");
    expect(content).toBe(log.toJSONL());
    expect(verifyAuditLog(content, "k")).toEqual({ ok: true, count: 2, head: log.head, lastType: "b" });
  });
});

describe("verifyAuditLog options", () => {
  it("requireHmac fails without a key, passes with the right key", () => {
    const keyed = build(3, "k").toJSONL();
    expect(verifyAuditLog(keyed, undefined, { requireHmac: true })).toMatchObject({ ok: false, count: 0, reason: "an HMAC key is required to verify this log" });
    expect(verifyAuditLog(keyed, "k", { requireHmac: true }).ok).toBe(true);
    // an attacker re-chaining an unkeyed forgery is rejected when HMAC is required
    expect(verifyAuditLog(build(3).toJSONL(), undefined, { requireHmac: true }).ok).toBe(false);
  });

  it("expectHead detects truncation and rewrites", () => {
    const log = build(5);
    const ls = lines(log.toJSONL());
    expect(verifyAuditLog(log.toJSONL(), undefined, { expectHead: log.head }).ok).toBe(true);
    const cut = verifyAuditLog(join_(ls.slice(0, 3)), undefined, { expectHead: log.head });
    expect(cut.ok).toBe(false);
    expect(cut.reason).toBe(`head ${log.entries[2]!.hash} does not match the expected head ${log.head}`);
    expect(cut.count).toBe(3);
  });

  it("requireLastType detects a truncated tail", () => {
    const log = new AuditLog({ now: fixedClock() });
    log.append("evaluation_start", {});
    log.append("run", {});
    log.append("evaluation_end", {});
    const ls = lines(log.toJSONL());
    expect(verifyAuditLog(log.toJSONL(), undefined, { requireLastType: ["evaluation_end", "artifacts"] })).toMatchObject({ ok: true, lastType: "evaluation_end" });
    const cut = verifyAuditLog(join_(ls.slice(0, 2)), undefined, { requireLastType: ["evaluation_end", "artifacts"] });
    expect(cut.ok).toBe(false);
    expect(cut.reason).toBe('log ends with "run", expected evaluation_end or artifacts: it may be truncated');
    expect(verifyAuditLog("", undefined, { requireLastType: ["evaluation_end"] }).reason).toContain('"(empty)"');
  });

  it("chain errors take precedence over option checks", () => {
    const ls = lines(build(3).toJSONL());
    ls[1] = "garbage";
    expect(verifyAuditLog(join_(ls), undefined, { requireLastType: ["x"], expectHead: "y" }).reason).toBe("line 2 is not valid JSON");
  });
});

describe("audit payload canonicalisation", () => {
  it("a __proto__ key in the payload is kept and affects the hash", () => {
    const mk = (json: string) => {
      const log = new AuditLog({ now: fixedClock() });
      log.append("x", JSON.parse(json));
      return log;
    };
    const a = mk('{"__proto__":{"evil":1},"ok":true}');
    const b = mk('{"__proto__":{"evil":2},"ok":true}');
    const c = mk('{"ok":true}');
    expect(a.head).not.toBe(b.head);
    expect(a.head).not.toBe(c.head);
    expect(verifyAuditLog(a.toJSONL()).ok).toBe(true);
    expect(canonicalJSON(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toBe('{"__proto__":{"x":1},"a":2}');
    // editing the __proto__ payload in the file is detected
    const edited = a.toJSONL().replace('"evil":1', '"evil":2');
    expect(verifyAuditLog(edited).ok).toBe(false);
  });

  it("encodes ±Infinity and NaN as strings, so they survive the file round trip", () => {
    const log = new AuditLog({ now: fixedClock() });
    const e = log.append("m", { hi: Infinity, lo: -Infinity, nan: NaN, n: 1 });
    expect(e.payload).toEqual({ hi: "Infinity", lo: "-Infinity", nan: "NaN", n: 1 });
    expect(log.toJSONL()).toContain('"hi":"Infinity"');
    expect(verifyAuditLog(log.toJSONL()).ok).toBe(true);
    // Infinity is distinguishable from null (it used to serialize to null)
    const nul = new AuditLog({ now: fixedClock() });
    nul.append("m", { hi: null, lo: -Infinity, nan: NaN, n: 1 });
    expect(nul.head).not.toBe(log.head);
  });

  it("canonicalJSON distinguishes Infinity from null at any depth", () => {
    expect(canonicalJSON({ a: [Infinity] })).toBe('{"a":["Infinity"]}');
    expect(sha256(canonicalJSON({ a: Infinity }))).not.toBe(sha256(canonicalJSON({ a: null })));
  });
});
