import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Task } from "@grahmos/gate";

/**
 * Pool manager: decides which task families each part of the system may see.
 *
 *  train   — agents learn from these (SFT export, RL environments)
 *  dev     — day-to-day progress checks while tuning
 *  holdout — gate certification only; stored sealed, opened by the verifier
 *  canary  — contamination tripwires; never trained on, never shown to developers
 *
 * Splits are by FAMILY, not by task, so near-duplicate variants cannot leak
 * across pools. Assignment is a deterministic function of (salt, family): the
 * same salt always gives the same split, and changing the salt reshuffles it.
 * Keep the salt secret if developers must not be able to compute the holdout.
 */

export type Pool = "train" | "dev" | "holdout" | "canary";
export const POOLS: readonly Pool[] = ["train", "dev", "holdout", "canary"];

export interface PoolRatios {
  train: number;
  dev: number;
  holdout: number;
  canary: number;
}

export const DEFAULT_RATIOS: PoolRatios = { train: 0.6, dev: 0.2, holdout: 0.15, canary: 0.05 };

export interface PoolConfig {
  salt: string;
  ratios?: PoolRatios;
  /** Explicit assignments that override the hash split (e.g. pin a family to holdout). */
  pinned?: Record<string, Pool>;
}

export interface RetiredFamily {
  family: string;
  reason: string;
  at: string;
}

export interface PoolState {
  version: 1 | 2;
  /**
   * v2: `saltCheck` is a scrypt hash of the salt (a plain SHA-256 of a short
   * salt can be brute-forced, which would reveal the holdout split), and
   * `configSha256` pins the ratios and pins the state was written with.
   */
  config: Omit<PoolConfig, "salt"> & { saltSha256?: string; saltCheck?: { salt: string; hash: string }; configSha256?: string };
  retired: RetiredFamily[];
}

const SALT_CHECK = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function saltCheck(salt: string, checkSalt = randomBytes(16)): { salt: string; hash: string } {
  return { salt: checkSalt.toString("base64"), hash: scryptSync(salt, checkSalt, 32, SALT_CHECK).toString("base64") };
}

/** Hash of the split-defining config (ratios and pins), independent of key order. */
function configHash(cfg: Pick<PoolConfig, "ratios" | "pinned">): string {
  const r = cfg.ratios ?? DEFAULT_RATIOS;
  const pins = Object.entries(cfg.pinned ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha(JSON.stringify({ ratios: [r.train, r.dev, r.holdout, r.canary], pins }));
}

/** Uniform number in [0, 1) derived from the salt and family name. */
export function familyUnit(salt: string, family: string): number {
  const h = createHash("sha256").update(salt).update("\u0000").update(family).digest();
  return h.readUIntBE(0, 6) / 2 ** 48;
}

export function assignPool(family: string, cfg: PoolConfig): Pool {
  const pin = cfg.pinned?.[family];
  if (pin) return pin;
  const r = cfg.ratios ?? DEFAULT_RATIOS;
  const total = r.train + r.dev + r.holdout + r.canary;
  if (!(total > 0)) throw new Error("pool ratios must sum to a positive number");
  const u = familyUnit(cfg.salt, family) * total;
  if (u < r.train) return "train";
  if (u < r.train + r.dev) return "dev";
  if (u < r.train + r.dev + r.holdout) return "holdout";
  return "canary";
}

export class PoolManager {
  private readonly retired = new Map<string, RetiredFamily>();

  constructor(
    private readonly cfg: PoolConfig,
    state?: PoolState,
  ) {
    if (!cfg.salt || cfg.salt.length < 16) throw new Error("pool salt must be at least 16 characters");
    if (state) {
      const c = state.config;
      if (c.saltCheck) {
        if (saltCheck(cfg.salt, Buffer.from(c.saltCheck.salt, "base64")).hash !== c.saltCheck.hash) throw new Error("pool state was written with a different salt");
      } else if (c.saltSha256 !== sha(cfg.salt)) throw new Error("pool state was written with a different salt");
      // A different split would silently move families between pools (train ↔ holdout).
      const expected = c.configSha256 ?? configHash(c);
      if (expected !== configHash(cfg)) throw new Error("pool state was written with different ratios or pins; refusing to re-split families");
      for (const r of state.retired) this.retired.set(r.family, r);
    }
  }

  /** Pool for a family, or "retired" if it has leaked and been withdrawn. */
  poolOf(family: string): Pool | "retired" {
    return this.retired.has(family) ? "retired" : assignPool(family, this.cfg);
  }

  poolOfTask(t: Pick<Task, "family">): Pool | "retired" {
    return this.poolOf(t.family);
  }

  /** Tasks currently in a pool (retired families are excluded everywhere). */
  select<T extends Pick<Task, "family">>(pool: Pool, tasks: T[]): T[] {
    return tasks.filter((t) => this.poolOf(t.family) === pool);
  }

  /** Throws unless the task's family is in one of the allowed pools. Use at every boundary. */
  require(t: Pick<Task, "family" | "id">, allowed: Pool[], purpose: string): void {
    const p = this.poolOfTask(t);
    if (p === "retired" || !allowed.includes(p)) {
      throw new PoolViolationError(`${purpose}: task ${t.id} (family ${t.family}) is in pool "${p}", allowed: ${allowed.join(", ")}`);
    }
  }

  /** Withdraws a family from every pool, e.g. after it appeared in training data or a prompt. */
  retire(family: string, reason: string, at = new Date()): RetiredFamily {
    const r = { family, reason, at: at.toISOString() };
    this.retired.set(family, r);
    return r;
  }

  get retiredFamilies(): RetiredFamily[] {
    return [...this.retired.values()];
  }

  /** Per-pool family counts for a task list; used to check the S1 minimum (≥ 8 messy families in 8–16h). */
  summary(tasks: Pick<Task, "family" | "humanMinutes" | "messiness">[]): Record<Pool | "retired", { families: number; tasks: number }> {
    const out = Object.fromEntries([...POOLS, "retired"].map((p) => [p, { families: 0, tasks: 0 }])) as Record<Pool | "retired", { families: number; tasks: number }>;
    const seen = new Set<string>();
    for (const t of tasks) {
      const p = this.poolOf(t.family);
      out[p].tasks++;
      if (!seen.has(t.family)) {
        seen.add(t.family);
        out[p].families++;
      }
    }
    return out;
  }

  /** Serializable state (the salt itself is never written, only a slow hash of it). */
  state(): PoolState {
    const { salt, ...rest } = this.cfg;
    return { version: 2, config: { ...rest, saltCheck: saltCheck(salt), configSha256: configHash(this.cfg) }, retired: this.retiredFamilies };
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify(this.state(), null, 2));
  }

  static load(path: string, cfg: PoolConfig): PoolManager {
    return new PoolManager(cfg, existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as PoolState) : undefined);
  }
}

export class PoolViolationError extends Error {
  override name = "PoolViolationError";
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- canaries

/**
 * Canary strings: unique markers planted in held-out and canary material.
 * If one ever shows up in training data, a prompt, or a model's output, that
 * material has leaked. (Same idea as the BIG-bench canary GUID.)
 */
export const CANARY_PREFIX = "GRAHMOS-CANARY";

export function makeCanary(label: string, salt: string): string {
  return `${CANARY_PREFIX}-${createHash("sha256").update(salt).update(label).digest("hex").slice(0, 24)}`;
}

const CANARY_RE = new RegExp(`${CANARY_PREFIX}-[0-9a-f]{24}`, "g");

/** All canary strings found in a text. */
export function findCanaries(text: string): string[] {
  return [...new Set(text.match(CANARY_RE) ?? [])];
}

// ---------------------------------------------------------------- sealed holdout

/**
 * Held-out suites are stored encrypted (AES-256-GCM, key derived with scrypt
 * from a passphrase only the verifier holds). Sealing protects against casual
 * exposure in the repo and in training pipelines; it is not a substitute for
 * keeping the plaintext off developers' machines.
 */
const MAGIC = "GRAHMOS-SEALED-v1";
const TAG_BYTES = 16;
/** scrypt cost for new files (2^15 ≈ 100 ms; Node's default 2^14 is the floor). */
const KDF = { N: 1 << 15, r: 8, p: 1 };
const KDF_MAXMEM = 128 * 1024 * 1024;

export function seal(plaintext: string, passphrase: string, label = ""): string {
  if (passphrase.length < 16) throw new Error("passphrase must be at least 16 characters");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { ...KDF, maxmem: KDF_MAXMEM });
  const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  c.setAAD(Buffer.from(`${MAGIC}:${label}`));
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return JSON.stringify({ magic: MAGIC, label, kdf: KDF, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), body: body.toString("base64") });
}

export function unseal(sealed: string, passphrase: string): string {
  const s = JSON.parse(sealed) as { magic: string; label: string; kdf?: { N: number; r: number; p: number }; salt: string; iv: string; tag: string; body: string };
  if (s.magic !== MAGIC) throw new Error("not a sealed GrahmOS file");
  // Files written before kdf was recorded used Node's defaults. Bounds stop a
  // crafted file from demanding unbounded memory or time.
  const kdf = s.kdf ?? { N: 1 << 14, r: 8, p: 1 };
  if (!(Number.isInteger(Math.log2(kdf.N)) && kdf.N >= 1 << 14 && kdf.N <= 1 << 20 && kdf.r >= 1 && kdf.r <= 16 && kdf.p >= 1 && kdf.p <= 4)) throw new Error("sealed file has unsupported KDF parameters");
  const tag = Buffer.from(s.tag, "base64");
  if (tag.length !== TAG_BYTES) throw new Error("unseal failed: authentication tag must be 16 bytes");
  const key = scryptSync(passphrase, Buffer.from(s.salt, "base64"), 32, { ...kdf, maxmem: KDF_MAXMEM * 8 });
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"), { authTagLength: TAG_BYTES });
  d.setAAD(Buffer.from(`${MAGIC}:${s.label}`));
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(Buffer.from(s.body, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new Error("unseal failed: wrong passphrase or the file was modified");
  }
}

export function sealFile(src: string, out: string, passphrase: string): void {
  writeFileSync(out, seal(readFileSync(src, "utf8"), passphrase, basename(src)));
}

/**
 * Decrypts a sealed suite module to a private temp file, imports it, and
 * deletes the plaintext. The module must export `suite` or a default Task[].
 * The module must be self-contained (bundle it, e.g. with esbuild, before
 * sealing): it runs from a private temp directory, where bare package
 * imports do not resolve.
 */
export async function loadSealedSuite(path: string, passphrase: string): Promise<Task[]> {
  const src = unseal(readFileSync(path, "utf8"), passphrase);
  const dir = mkdtempSync(join(tmpdir(), "grahmos-holdout-"));
  chmodSync(dir, 0o700);
  const file = join(dir, "suite.mjs");
  try {
    writeFileSync(file, src, { mode: 0o600 });
    const mod = (await import(pathToFileURL(file).href)) as { suite?: Task[]; default?: Task[] };
    const suite = mod.suite ?? mod.default;
    if (!Array.isArray(suite)) throw new Error("sealed module must export `suite` or a default Task[]");
    return suite;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
