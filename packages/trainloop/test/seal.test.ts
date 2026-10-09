import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSealedSuite, seal, sealFile, unseal } from "../src/pools.js";
import { tempDir } from "./helpers.js";

const PASS = "correct horse battery staple!!";

describe("seal / unseal", () => {
  it("round-trips text, including unicode", () => {
    const text = "held-out suite — ünïcödé ✓\nline 2";
    const s = seal(text, PASS, "suite.mjs");
    expect(s).not.toContain("held-out");
    const parsed = JSON.parse(s) as Record<string, string>;
    expect(parsed.magic).toBe("GRAHMOS-SEALED-v1");
    expect(parsed.label).toBe("suite.mjs");
    expect(unseal(s, PASS)).toBe(text);
  });

  it("uses a fresh salt and IV each time", () => {
    expect(seal("x", PASS)).not.toBe(seal("x", PASS));
  });

  it("rejects a wrong passphrase", () => {
    const s = seal("secret", PASS);
    expect(() => unseal(s, `${PASS}?`)).toThrow(/unseal failed/);
  });

  it("rejects tampered ciphertext, tag, or label", () => {
    const s = JSON.parse(seal("secret payload", PASS, "lbl")) as Record<string, string>;
    const body = Buffer.from(s.body!, "base64");
    body[0] = body[0]! ^ 1;
    expect(() => unseal(JSON.stringify({ ...s, body: body.toString("base64") }), PASS)).toThrow(/unseal failed/);
    const tag = Buffer.from(s.tag!, "base64");
    tag[3] = tag[3]! ^ 0x80;
    expect(() => unseal(JSON.stringify({ ...s, tag: tag.toString("base64") }), PASS)).toThrow(/unseal failed/);
    // The label is authenticated data.
    expect(() => unseal(JSON.stringify({ ...s, label: "other" }), PASS)).toThrow(/unseal failed/);
  });

  it("records the KDF parameters and a 16-byte tag", () => {
    const s = JSON.parse(seal("x", PASS)) as { kdf: unknown; tag: string; salt: string; iv: string };
    expect(s.kdf).toEqual({ N: 2 ** 15, r: 8, p: 1 });
    expect(Buffer.from(s.tag, "base64")).toHaveLength(16);
    expect(Buffer.from(s.salt, "base64")).toHaveLength(16);
    expect(Buffer.from(s.iv, "base64")).toHaveLength(12);
  });

  it("rejects truncated or extended authentication tags", () => {
    const s = JSON.parse(seal("secret", PASS)) as Record<string, string>;
    const tag = Buffer.from(s.tag!, "base64");
    for (const t of [tag.subarray(0, 4), tag.subarray(0, 12), Buffer.concat([tag, Buffer.from([0])])]) {
      expect(() => unseal(JSON.stringify({ ...s, tag: t.toString("base64") }), PASS)).toThrow(/tag must be 16 bytes/);
    }
  });

  it("rejects out-of-bounds KDF parameters before deriving a key", () => {
    const s = JSON.parse(seal("secret", PASS)) as Record<string, unknown>;
    for (const kdf of [
      { N: 2 ** 13, r: 8, p: 1 },
      { N: 2 ** 21, r: 8, p: 1 },
      { N: 3 * 2 ** 14, r: 8, p: 1 },
      { N: 2 ** 15, r: 0, p: 1 },
      { N: 2 ** 15, r: 17, p: 1 },
      { N: 2 ** 15, r: 8, p: 0 },
      { N: 2 ** 15, r: 8, p: 5 },
    ]) {
      expect(() => unseal(JSON.stringify({ ...s, kdf }), PASS)).toThrow(/unsupported KDF parameters/);
    }
    // A changed but in-bounds KDF derives a different key: authentication fails.
    expect(() => unseal(JSON.stringify({ ...s, kdf: { N: 2 ** 14, r: 8, p: 1 } }), PASS)).toThrow(/unseal failed/);
  });

  it("opens legacy files without a kdf field (scrypt defaults N=2^14)", () => {
    // Build a legacy-format file the way the v1 sealer did.
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(PASS, salt, 32);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from("GRAHMOS-SEALED-v1:old"));
    const body = Buffer.concat([c.update("legacy text", "utf8"), c.final()]);
    const legacy = JSON.stringify({ magic: "GRAHMOS-SEALED-v1", label: "old", salt: salt.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), body: body.toString("base64") });
    expect(unseal(legacy, PASS)).toBe("legacy text");
  });

  it("rejects files that are not sealed", () => {
    expect(() => unseal(JSON.stringify({ magic: "nope" }), PASS)).toThrow(/not a sealed/);
  });

  it("rejects passphrases shorter than 16 characters", () => {
    expect(() => seal("x", "short")).toThrow(/16/);
    expect(() => seal("x", "a".repeat(15))).toThrow(/16/);
    expect(() => seal("x", "a".repeat(16))).not.toThrow();
  });

  it("sealFile labels the output with the source file name", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "plain.txt"), "hello");
    sealFile(join(dir, "plain.txt"), join(dir, "plain.sealed"), PASS);
    const sealed = readFileSync(join(dir, "plain.sealed"), "utf8");
    expect((JSON.parse(sealed) as { label: string }).label).toBe("plain.txt");
    expect(unseal(sealed, PASS)).toBe("hello");
  });
});

describe("loadSealedSuite", () => {
  // Redirect os.tmpdir() so we can check the plaintext directory is removed.
  let prevTmp: string | undefined;
  let scratch: string;
  beforeEach(() => {
    prevTmp = process.env.TMPDIR;
    scratch = tempDir("trainloop-holdout-scratch-");
    process.env.TMPDIR = scratch;
  });
  const holdoutDirs = () => readdirSync(scratch).filter((n) => n.startsWith("grahmos-holdout-"));
  afterEach(() => {
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
  });

  const MODULE = `
export const suite = [
  {
    id: "h1",
    title: "Held-out one",
    family: "holdout-fam",
    prompt: "write OK to out.txt",
    humanMinutes: 5,
    messiness: "low",
    files: { "in.txt": "x" },
    protectedPaths: [],
    grade(fs) {
      const pass = fs.read("out.txt") === "OK";
      return { pass, score: pass ? 1 : 0, details: pass ? "ok" : "no" };
    },
  },
];
`;

  it("decrypts, imports and returns the tasks, then deletes the plaintext", async () => {
    const dir = tempDir();
    const path = join(dir, "holdout.sealed");
    writeFileSync(path, seal(MODULE, PASS, "holdout.mjs"));
    const tasks = await loadSealedSuite(path, PASS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe("h1");
    const okFs = { read: (p: string) => (p === "out.txt" ? "OK" : undefined), exists: () => true, list: () => [] };
    expect(tasks[0]!.grade(okFs).pass).toBe(true);
    expect(tasks[0]!.grade({ ...okFs, read: () => "nope" }).pass).toBe(false);
    expect(holdoutDirs()).toEqual([]);
  });

  it("accepts a default export", async () => {
    const dir = tempDir();
    const path = join(dir, "holdout.sealed");
    writeFileSync(path, seal(MODULE.replace("export const suite =", "export default"), PASS));
    expect((await loadSealedSuite(path, PASS)).map((t) => t.id)).toEqual(["h1"]);
    expect(holdoutDirs()).toEqual([]);
  });

  it("throws on a module without a suite and still removes the plaintext", async () => {
    const dir = tempDir();
    const path = join(dir, "bad.sealed");
    writeFileSync(path, seal("export const nothing = 1;\n", PASS));
    await expect(loadSealedSuite(path, PASS)).rejects.toThrow(/must export `suite`/);
    expect(holdoutDirs()).toEqual([]);
  });

  it("fails before writing anything when the passphrase is wrong", async () => {
    const dir = tempDir();
    const path = join(dir, "holdout.sealed");
    writeFileSync(path, seal(MODULE, PASS));
    await expect(loadSealedSuite(path, "wrong passphrase 123456")).rejects.toThrow(/unseal failed/);
    expect(holdoutDirs()).toEqual([]);
  });
});
