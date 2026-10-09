import { simulatedAgent, type SimProfile } from "./agents/simulated.js";
import { logit } from "./horizon.js";
import { runSuite } from "./runner.js";
import { computeMetrics, DEFAULT_GATES, evaluateGates } from "./scoring.js";
import { defineOutputTask } from "./suites/define.js";
import type { Gate, GateStatus, Messiness, Task } from "./types.js";
import { mulberry32 } from "./util.js";

/**
 * Self-calibration: Monte Carlo check that a gate's verdicts are honest.
 *
 * Simulated agents with a known true horizon (set as a multiple of the
 * gate's threshold) are run many times on a synthetic suite that has enough
 * tasks in every window. The share of PASS at multiples ≤ 1 is the gate's
 * false-pass rate; at multiples > 1 it is the gate's power.
 *
 * The synthetic tasks are trivial (sum a list); simulated agents only use
 * their human-time label. This measures the statistics, not task quality.
 */

/** Synthetic suite with ≥ 8 tasks of each messiness in [480, 960] and [2400, 4800] minutes. */
export function calibrationSuite(): Task[] {
  const grid = [2, 4, 8, 15, 30, 60, 120, 240, 480, 540, 600, 660, 720, 780, 840, 960, 2400, 2700, 3000, 3300, 3600, 3900, 4200, 4800];
  const tasks: Task[] = [];
  const rand = mulberry32(20261009);
  for (const messiness of ["low", "high"] as Messiness[]) {
    for (const minutes of grid) {
      const nums = Array.from({ length: 6 }, () => Math.round(rand() * 1000));
      const id = `calib-${messiness}-${minutes}`;
      tasks.push(
        defineOutputTask({
          id,
          title: `Calibration task ${minutes} min (${messiness})`,
          family: id,
          humanMinutes: minutes,
          messiness,
          prompt: "Sum the numbers in `nums.json`. Output: {\"sum\": number}.",
          inputs: { "nums.json": JSON.stringify(nums) },
          outputPath: "out/sum.json",
          solve: (i) => ({ sum: (JSON.parse(i["nums.json"]!) as number[]).reduce((s, v) => s + v, 0) }),
          wrong: (i) => ({ sum: (JSON.parse(i["nums.json"]!) as number[]).slice(1).reduce((s, v) => s + v, 0) }),
        }),
      );
    }
  }
  return tasks;
}

export interface CalibrationRow {
  multiple: number;
  trueHorizonMinutes: number;
  sims: number;
  pass: number;
  insufficient: number;
  fail: number;
}

export interface CalibrationOptions {
  gate?: Gate;
  multiples?: number[];
  repeats?: number;
  sims?: number;
  bootstrap?: number;
  slope?: number;
  /** Task-to-task variation (sd on the logit scale); each simulation draws a new set of task effects. */
  taskSd?: number;
  seed?: number;
  tasks?: Task[];
  onProgress?: (done: number, total: number) => void;
}

export async function calibrate(o: CalibrationOptions = {}): Promise<{ gate: Gate; rows: CalibrationRow[] }> {
  const gate = o.gate ?? DEFAULT_GATES.find((g) => g.id === "S1")!;
  const req = gate.requirements.find((r) => r.metric === "horizon50" || r.metric === "horizon80");
  if (!req) throw new Error(`gate ${gate.id} has no horizon requirement to calibrate`);
  const p = req.metric === "horizon50" ? 0.5 : 0.8;
  const slope = o.slope ?? 1;
  const tasks = o.tasks ?? calibrationSuite();
  const multiples = o.multiples ?? [0.75, 1, 2, 4];
  const sims = o.sims ?? 50;
  const rows: CalibrationRow[] = [];
  let done = 0;
  for (const multiple of multiples) {
    const trueHp = req.value * multiple;
    // Convert the true p-horizon into the simulated agent's 50% horizon for this slope.
    const h50 = trueHp * 2 ** (logit(p) / slope);
    const base: SimProfile = { name: `calib:${multiple}x`, horizonMinutes: h50, slope, taskEffectSd: o.taskSd ?? 0 };
    const row: CalibrationRow = { multiple, trueHorizonMinutes: trueHp, sims, pass: 0, insufficient: 0, fail: 0 };
    for (let s = 0; s < sims; s++) {
      const seed = (o.seed ?? 1) * 100_003 + s;
      // With task variation, the truth is the population-average horizon; each simulation draws new tasks.
      const agent = simulatedAgent({ ...base, taskEffectSeed: seed }, tasks);
      const recs = await runSuite(tasks, agent, { repeats: o.repeats ?? 12, seed });
      const m = computeMetrics(recs, "failure", { bootstrap: o.bootstrap ?? 100, seed });
      // Calibrate the horizon requirement on its own: integrity requirements are trivially met here.
      const verdict: GateStatus = evaluateGates(m, [{ ...gate, requirements: [req] }])[0]!.status;
      row[verdict]++;
      o.onProgress?.(++done, multiples.length * sims);
    }
    rows.push(row);
  }
  return { gate, rows };
}
