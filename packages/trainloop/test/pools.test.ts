import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assignPool,
  CANARY_PREFIX,
  DEFAULT_RATIOS,
  familyUnit,
  findCanaries,
  makeCanary,
  POOLS,
  PoolManager,
  PoolViolationError,
  type Pool,
  type PoolRatios,
  type PoolState,
} from "../src/pools.js";
import { SALT, tempDir } from "./helpers.js";

const families = (n: number) => Array.from({ length: n }, (_, i) => `family-${i}`);

describe("familyUnit / assignPool", () => {
  it("is deterministic in (salt, family) and uniform in [0,1)", () => {
    expect(familyUnit(SALT, "a")).toBe(familyUnit(SALT, "a"));
    expect(familyUnit(SALT, "a")).not.toBe(familyUnit(SALT, "b"));
    for (const f of families(500)) {
      const u = familyUnit(SALT, f);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it("assigns the same pool on repeated calls and across fresh managers", () => {
    const a = families(200).map((f) => assignPool(f, { salt: SALT }));
    const b = families(200).map((f) => assignPool(f, { salt: SALT }));
    expect(a).toEqual(b);
    const m = new PoolManager({ salt: SALT });
    expect(families(200).map((f) => m.poolOf(f))).toEqual(a);
  });

  it("matches the configured ratios over many families (±1.5 points)", () => {
    const n = 20_000;
    for (const ratios of [DEFAULT_RATIOS, { train: 0.25, dev: 0.45, holdout: 0.25, canary: 0.05 }] as PoolRatios[]) {
      const counts: Record<Pool, number> = { train: 0, dev: 0, holdout: 0, canary: 0 };
      for (const f of families(n)) counts[assignPool(f, { salt: SALT, ratios })]++;
      for (const p of POOLS) expect(Math.abs(counts[p] / n - ratios[p])).toBeLessThan(0.015);
    }
  });

  it("normalizes ratios that do not sum to 1", () => {
    const n = 10_000;
    let train = 0;
    for (const f of families(n)) if (assignPool(f, { salt: SALT, ratios: { train: 3, dev: 1, holdout: 0, canary: 0 } }) === "train") train++;
    expect(Math.abs(train / n - 0.75)).toBeLessThan(0.02);
  });

  it("rejects non-positive ratio totals", () => {
    expect(() => assignPool("x", { salt: SALT, ratios: { train: 0, dev: 0, holdout: 0, canary: 0 } })).toThrow(/positive/);
  });

  it("zero-ratio pools never receive families", () => {
    for (const f of families(2000)) expect(assignPool(f, { salt: SALT, ratios: { train: 1, dev: 0, holdout: 1, canary: 0 } })).toMatch(/^(train|holdout)$/);
  });

  it("pinned assignments override the hash split", () => {
    const fs = families(200);
    const free = fs.map((f) => assignPool(f, { salt: SALT }));
    const target = fs.findIndex((_, i) => free[i] !== "holdout");
    const pinned = { [fs[target]!]: "holdout" as Pool };
    expect(assignPool(fs[target]!, { salt: SALT, pinned })).toBe("holdout");
    // Everyone else is unchanged.
    fs.forEach((f, i) => i !== target && expect(assignPool(f, { salt: SALT, pinned })).toBe(free[i]));
  });

  it("changing the salt reshuffles the split", () => {
    const fs = families(2000);
    const a = fs.map((f) => assignPool(f, { salt: SALT }));
    const b = fs.map((f) => assignPool(f, { salt: `${SALT}-other` }));
    const changed = a.filter((p, i) => p !== b[i]).length / fs.length;
    // Two independent draws from (0.6, 0.2, 0.15, 0.05) disagree with prob 1 − Σp² ≈ 0.57.
    expect(changed).toBeGreaterThan(0.45);
    expect(changed).toBeLessThan(0.7);
  });
});

describe("PoolManager", () => {
  const tasks = [
    { id: "t1", family: "A", humanMinutes: 10, messiness: "low" as const },
    { id: "t2", family: "A", humanMinutes: 20, messiness: "high" as const },
    { id: "t3", family: "B", humanMinutes: 30, messiness: "low" as const },
    { id: "t4", family: "C", humanMinutes: 40, messiness: "low" as const },
    { id: "t5", family: "D", humanMinutes: 50, messiness: "low" as const },
  ];
  const mk = () => new PoolManager({ salt: SALT, pinned: { A: "train", B: "train", C: "holdout", D: "dev" } });

  it("requires a salt of at least 16 characters", () => {
    expect(() => new PoolManager({ salt: "short" })).toThrow(/16/);
    expect(() => new PoolManager({ salt: "" })).toThrow(/16/);
    expect(() => new PoolManager({ salt: "x".repeat(16) })).not.toThrow();
  });

  it("select returns tasks in a pool; require throws PoolViolationError outside allowed pools", () => {
    const m = mk();
    expect(m.select("train", tasks).map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(m.select("holdout", tasks).map((t) => t.id)).toEqual(["t4"]);
    expect(m.poolOfTask(tasks[4]!)).toBe("dev");
    expect(() => m.require(tasks[0]!, ["train"], "SFT")).not.toThrow();
    expect(() => m.require(tasks[3]!, ["train"], "SFT")).toThrow(PoolViolationError);
    expect(() => m.require(tasks[3]!, ["train"], "SFT")).toThrow(/SFT: task t4 \(family C\) is in pool "holdout"/);
    expect(() => m.require(tasks[3]!, ["train", "holdout"], "verify")).not.toThrow();
  });

  it("retired families are excluded everywhere", () => {
    const m = mk();
    const at = new Date("2026-01-02T03:04:05Z");
    const r = m.retire("A", "leaked into a prompt", at);
    expect(r).toEqual({ family: "A", reason: "leaked into a prompt", at: at.toISOString() });
    expect(m.poolOf("A")).toBe("retired");
    for (const p of POOLS) expect(m.select(p, tasks).some((t) => t.family === "A")).toBe(false);
    expect(() => m.require(tasks[0]!, ["train", "dev", "holdout", "canary"], "anything")).toThrow(PoolViolationError);
    expect(m.retiredFamilies).toEqual([r]);
  });

  it("summary counts families and tasks per pool, including retired", () => {
    const m = mk();
    m.retire("B", "x");
    const s = m.summary(tasks);
    expect(s.train).toEqual({ families: 1, tasks: 2 });
    expect(s.retired).toEqual({ families: 1, tasks: 1 });
    expect(s.holdout).toEqual({ families: 1, tasks: 1 });
    expect(s.dev).toEqual({ families: 1, tasks: 1 });
    expect(s.canary).toEqual({ families: 0, tasks: 0 });
  });

  it("state() never contains the salt; save/load round-trips retirements", () => {
    const m = mk();
    m.retire("C", "seen in training data", new Date("2026-05-01T00:00:00Z"));
    const st = m.state();
    expect(st.version).toBe(2);
    expect(JSON.stringify(st)).not.toContain(SALT);
    expect(st.config.saltSha256).toBeUndefined();
    expect(Buffer.from(st.config.saltCheck!.salt, "base64")).toHaveLength(16);
    expect(Buffer.from(st.config.saltCheck!.hash, "base64")).toHaveLength(32);
    expect(st.config.configSha256).toMatch(/^[0-9a-f]{64}$/);
    // The salt check is randomized per save, the config hash is not.
    expect(m.state().config.saltCheck!.salt).not.toBe(st.config.saltCheck!.salt);
    expect(m.state().config.configSha256).toBe(st.config.configSha256);
    expect(st.config.pinned).toEqual({ A: "train", B: "train", C: "holdout", D: "dev" });

    const dir = tempDir();
    const path = join(dir, "pools.json");
    m.save(path);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(SALT);
    const back = PoolManager.load(path, { salt: SALT, pinned: { A: "train", B: "train", C: "holdout", D: "dev" } });
    expect(back.poolOf("C")).toBe("retired");
    expect(back.retiredFamilies).toEqual(m.retiredFamilies);
  });

  it("load rejects state written with a different salt", () => {
    const dir = tempDir();
    const path = join(dir, "pools.json");
    mk().save(path);
    expect(() => PoolManager.load(path, { salt: `${SALT}-wrong` })).toThrow(/different salt/);
  });

  it("load refuses state written with different ratios or pins", () => {
    const pins = { A: "train", B: "train", C: "holdout", D: "dev" } as const;
    const path = join(tempDir(), "pools.json");
    mk().save(path);
    expect(() => PoolManager.load(path, { salt: SALT, pinned: { ...pins, D: "train" } })).toThrow(/different ratios or pins/);
    expect(() => PoolManager.load(path, { salt: SALT, pinned: { ...pins }, ratios: { train: 0.5, dev: 0.3, holdout: 0.15, canary: 0.05 } })).toThrow(/different ratios or pins/);
    expect(() => PoolManager.load(path, { salt: SALT })).toThrow(/different ratios or pins/);
    // Pin order and explicit default ratios do not matter.
    expect(() => PoolManager.load(path, { salt: SALT, ratios: { ...DEFAULT_RATIOS }, pinned: { D: "dev", C: "holdout", B: "train", A: "train" } })).not.toThrow();
  });

  it("still loads v1 states (sha256 salt hash, no config hash)", () => {
    const sha = (x: string) => createHash("sha256").update(x).digest("hex");
    const v1: PoolState = { version: 1, config: { pinned: { A: "holdout" }, saltSha256: sha(SALT) }, retired: [{ family: "B", reason: "old leak", at: "2026-01-01T00:00:00.000Z" }] };
    const m = new PoolManager({ salt: SALT, pinned: { A: "holdout" } }, v1);
    expect(m.poolOf("A")).toBe("holdout");
    expect(m.poolOf("B")).toBe("retired");
    expect(() => new PoolManager({ salt: `${SALT}-x`, pinned: { A: "holdout" } }, v1)).toThrow(/different salt/);
    expect(() => new PoolManager({ salt: SALT }, v1)).toThrow(/different ratios or pins/);
    // Re-saving upgrades to v2.
    expect(m.state().version).toBe(2);
  });

  it("load on a missing file starts fresh", () => {
    const path = join(tempDir(), "missing.json");
    expect(existsSync(path)).toBe(false);
    expect(PoolManager.load(path, { salt: SALT }).retiredFamilies).toEqual([]);
  });
});

describe("canaries", () => {
  it("makeCanary has the documented format and is deterministic", () => {
    const c = makeCanary("holdout-suite", SALT);
    expect(c).toMatch(new RegExp(`^${CANARY_PREFIX}-[0-9a-f]{24}$`));
    expect(makeCanary("holdout-suite", SALT)).toBe(c);
    expect(makeCanary("other", SALT)).not.toBe(c);
    expect(makeCanary("holdout-suite", `${SALT}x`)).not.toBe(c);
  });

  it("findCanaries finds every distinct canary and ignores look-alikes", () => {
    const a = makeCanary("a", SALT);
    const b = makeCanary("b", SALT);
    expect(findCanaries(`x ${a} y ${b} z ${a}`)).toEqual([a, b]);
    expect(findCanaries("nothing here")).toEqual([]);
    expect(findCanaries(`${CANARY_PREFIX}-xyz`)).toEqual([]);
    expect(findCanaries(`${CANARY_PREFIX}-${"A".repeat(24)}`)).toEqual([]); // uppercase hex is not a canary
    expect(findCanaries(JSON.stringify({ deep: { s: a } }))).toEqual([a]);
  });

  it("findCanaries is safe to call repeatedly (global regex state does not leak)", () => {
    const a = makeCanary("a", SALT);
    for (let i = 0; i < 5; i++) expect(findCanaries(a)).toEqual([a]);
  });
});
