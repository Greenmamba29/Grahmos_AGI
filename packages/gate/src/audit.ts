import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJSON, hmacSha256, jsonReplacer, sha256 } from "./util.js";

/**
 * Append-only, hash-chained audit log (JSONL).
 *
 * Each entry commits to the previous entry's hash, so editing, deleting,
 * reordering or inserting any line breaks verification from that point on.
 * With an HMAC key, entries are also authenticated: someone without the key
 * cannot rebuild a valid chain after tampering.
 */

export const GENESIS = "0".repeat(64);

export interface AuditEntry {
  seq: number;
  ts: string;
  type: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}

export interface AuditOptions {
  /** Secret for HMAC-SHA256 chaining. Without it, plain SHA-256 is used. */
  hmacKey?: string;
  /** Append each entry to this JSONL file as it is written. */
  filePath?: string;
  /** Clock override (tests). */
  now?: () => Date;
  /**
   * Keep entries in memory (default true). Long-running services set false:
   * only the head hash and count are kept, so memory stays flat.
   */
  retain?: boolean;
}

/**
 * Calls `fn` for each line of a file, reading in fixed-size chunks so files
 * larger than the maximum string length can be processed. A final line
 * without a trailing newline is passed with `complete = false`.
 */
export function forEachLine(path: string, fn: (line: string, complete: boolean, byteOffset: number) => void, chunkBytes = 1 << 20): void {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(chunkBytes);
    let carry: Buffer = Buffer.alloc(0);
    let offset = 0; // byte offset of carry[0]
    for (;;) {
      const n = readSync(fd, buf, 0, chunkBytes, null);
      if (n === 0) break;
      let data = Buffer.concat([carry, buf.subarray(0, n)]);
      let start = 0;
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        fn(data.toString("utf8", start, nl), true, offset + start);
        start = nl + 1;
      }
      offset += start;
      carry = Buffer.from(data.subarray(start));
      data = Buffer.alloc(0);
    }
    if (carry.length) fn(carry.toString("utf8"), false, offset);
  } finally {
    closeSync(fd);
  }
}

function entryHash(body: Omit<AuditEntry, "hash" | "prevHash">, prevHash: string, key?: string): string {
  const material = `${prevHash}\n${canonicalJSON(body)}`;
  return key ? hmacSha256(key, material) : sha256(material);
}

export class AuditLog {
  readonly entries: AuditEntry[] = [];
  private lastHash = GENESIS;
  private n = 0;
  private readonly retain: boolean;
  private readonly key?: string;
  private readonly filePath?: string;
  private readonly now: () => Date;

  constructor(opts: AuditOptions = {}) {
    this.key = opts.hmacKey;
    this.filePath = opts.filePath;
    this.now = opts.now ?? (() => new Date());
    this.retain = opts.retain ?? true;
    if (this.filePath) mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /**
   * Re-opens an existing JSONL log and continues its chain (for long-running
   * services that restart). The existing file is verified first; a broken
   * chain is refused rather than silently extended. The file is streamed,
   * so it may be larger than memory allows as one string. `onEntry` sees
   * every verified entry (e.g. to rebuild an index).
   */
  static resume(opts: AuditOptions & { filePath: string; onEntry?: (e: AuditEntry) => void }): AuditLog {
    const log = new AuditLog(opts);
    if (!existsSync(opts.filePath)) return log;
    const v = new ChainVerifier(opts.hmacKey);
    forEachLine(opts.filePath, (line, complete) => {
      if (!line.trim()) return;
      if (!complete) throw new Error(`cannot resume ${opts.filePath}: last line is incomplete (torn write)`);
      const e = v.push(line);
      if (!e) throw new Error(`cannot resume ${opts.filePath}: ${v.result().reason}`);
      if (log.retain) log.entries.push(e);
      opts.onEntry?.(e);
    });
    const r = v.result();
    log.lastHash = r.head;
    log.n = r.count;
    return log;
  }

  get head(): string {
    return this.lastHash;
  }

  /** Number of entries in the chain (including ones not retained in memory). */
  get count(): number {
    return this.n;
  }

  append(type: string, payload: unknown): AuditEntry {
    // Round-trip through JSON (keeping ±Infinity/NaN as strings) so the hashed
    // payload is exactly what a verifier will parse back from the file.
    const body = { seq: this.n, ts: this.now().toISOString(), type, payload: JSON.parse(JSON.stringify(payload ?? null, jsonReplacer)) };
    const prevHash = this.head;
    const entry: AuditEntry = { ...body, prevHash, hash: entryHash(body, prevHash, this.key) };
    if (this.retain) this.entries.push(entry);
    this.lastHash = entry.hash;
    this.n++;
    if (this.filePath) appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  toJSONL(): string {
    return this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length ? "\n" : "");
  }
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  head: string;
  /** Sequence number of the first bad entry. */
  brokenAt?: number;
  reason?: string;
  /** Type of the last entry (a complete evaluation ends with "evaluation_end" or "artifacts"). */
  lastType?: string;
}

export interface VerifyOptions {
  /** Fail if no HMAC key is supplied (prevents accepting a re-chained, unkeyed forgery). */
  requireHmac?: boolean;
  /** Fail unless the chain ends at this head hash (detects truncation and rewrites). */
  expectHead?: string;
  /** Fail unless the last entry is one of these types (detects truncation). */
  requireLastType?: string[];
}

/**
 * Verifies a JSONL audit log. Pass the same HMAC key used to write it.
 *
 * What a plain pass proves: the lines are an unbroken chain from genesis.
 * It does NOT prove the tail wasn't cut off, or that an unkeyed log wasn't
 * rebuilt from scratch — use requireLastType / expectHead / requireHmac for that.
 */
export function verifyAuditLog(jsonl: string, hmacKey?: string, opts: VerifyOptions = {}): VerifyResult {
  if (opts.requireHmac && !hmacKey) return { ok: false, count: 0, head: GENESIS, reason: "an HMAC key is required to verify this log" };
  const r = verifyChain(jsonl, hmacKey);
  if (!r.ok) return r;
  if (opts.requireLastType && !opts.requireLastType.includes(r.lastType ?? "")) {
    return { ...r, ok: false, reason: `log ends with "${r.lastType ?? "(empty)"}", expected ${opts.requireLastType.join(" or ")}: it may be truncated` };
  }
  if (opts.expectHead && opts.expectHead !== r.head) return { ...r, ok: false, reason: `head ${r.head} does not match the expected head ${opts.expectHead}` };
  return r;
}

/** Incremental chain verification, one line at a time. */
export class ChainVerifier {
  private prev = GENESIS;
  private i = 0;
  private last?: string;
  private failure?: VerifyResult;
  constructor(private readonly hmacKey?: string) {}

  /** Verifies the next line; returns the entry, or undefined once the chain is broken. */
  push(line: string): AuditEntry | undefined {
    if (this.failure) return undefined;
    const i = this.i;
    const fail = (reason: string) => ((this.failure = { ok: false, count: i, head: this.prev, brokenAt: i, reason }), undefined);
    let e: AuditEntry;
    try {
      e = JSON.parse(line) as AuditEntry;
    } catch {
      return fail(`line ${i + 1} is not valid JSON`);
    }
    if (e.seq !== i) return fail(`expected seq ${i}, found ${e.seq}`);
    if (e.prevHash !== this.prev) return fail(`prevHash does not match entry ${i - 1}`);
    const expected = entryHash({ seq: e.seq, ts: e.ts, type: e.type, payload: e.payload }, this.prev, this.hmacKey);
    if (expected !== e.hash) return fail(`hash mismatch at entry ${i} (content altered or wrong key)`);
    this.prev = e.hash;
    this.last = e.type;
    this.i++;
    return e;
  }

  result(): VerifyResult {
    return this.failure ?? { ok: true, count: this.i, head: this.prev, lastType: this.last };
  }
}

function verifyChain(jsonl: string, hmacKey?: string): VerifyResult {
  const v = new ChainVerifier(hmacKey);
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    if (!v.push(line)) break;
  }
  return v.result();
}
