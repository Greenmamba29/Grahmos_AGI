import { describe, expect, it } from "vitest";
import { calibrate, calibrationSuite } from "../src/calibrate.js";
import { DEFAULT_GATES } from "../src/scoring.js";
import type { Gate } from "../src/types.js";

describe("calibrationSuite", () => {
  const suite = calibrationSuite();

  it("has ≥ 8 tasks of each messiness in [480, 960] and in [2400, 4800], unique ids, own families", () => {
    expect(suite).toHaveLength(48);
    expect(new Set(suite.map((t) => t.id)).size).toBe(48);
    expect(new Set(suite.map((t) => t.family)).size).toBe(48);
    for (const mess of ["low", "high"] as const) {
      const ts = suite.filter((t) => t.messiness === mess);
      expect(ts.filter((t) => t.humanMinutes >= 480 && t.humanMinutes <= 960).length).toBeGreaterThanOrEqual(8);
      expect(ts.filter((t) => t.humanMinutes >= 2400 && t.humanMinutes <= 4800).length).toBeGreaterThanOrEqual(8);
    }
  });

  it("is deterministic", () => {
    expect(calibrationSuite().map((t) => t.files["nums.json"])).toEqual(suite.map((t) => t.files["nums.json"]));
  });
});

describe("calibrate", () => {
  it("tiny run: rows sum to sims, 4× passes more than 0.5×, deterministic", async () => {
    const opts = { multiples: [0.5, 4], sims: 3, repeats: 4, bootstrap: 20 };
    const progress: [number, number][] = [];
    const res = await calibrate({ ...opts, onProgress: (d, t) => progress.push([d, t]) });
    expect(res.gate.id).toBe("S1");
    expect(res.rows.map((r) => [r.multiple, r.trueHorizonMinutes, r.sims])).toEqual([
      [0.5, 240, 3],
      [4, 1920, 3],
    ]);
    for (const r of res.rows) expect(r.pass + r.insufficient + r.fail).toBe(r.sims);
    expect(res.rows[1]!.pass).toBeGreaterThan(res.rows[0]!.pass);
    expect(res.rows[0]!.pass).toBe(0); // no false passes at half the threshold
    expect(progress.at(-1)).toEqual([6, 6]);
    const again = await calibrate(opts);
    expect(again.rows).toEqual(res.rows);
  });

  it("calibrates a horizon50 gate and rejects a gate without a horizon requirement", async () => {
    const s0 = DEFAULT_GATES.find((g) => g.id === "S0")!;
    const res = await calibrate({ gate: s0, multiples: [4], sims: 1, repeats: 2, bootstrap: 5, tasks: calibrationSuite().filter((t) => t.messiness === "low") });
    expect(res.rows[0]!.trueHorizonMinutes).toBe(1920);
    expect(res.rows[0]!.sims).toBe(1);
    const noHorizon: Gate = { id: "R", name: "r", description: "", requirements: [{ metric: "cheatRate", op: "<=", value: 0.1 }] };
    await expect(calibrate({ gate: noHorizon, sims: 1 })).rejects.toThrow("gate R has no horizon requirement to calibrate");
  });
});
