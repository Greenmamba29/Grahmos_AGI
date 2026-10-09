import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exampleSuite, type GradeResult, type Task, type ToolAPI } from "@grahmos/gate";
import { PoolManager } from "../src/pools.js";

export const SALT = "test-salt-0123456789abcdef";

export const tempDir = (prefix = "trainloop-test-") => mkdtempSync(join(tmpdir(), prefix));

export const taskById = (id: string): Task => {
  const t = exampleSuite.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};

/** Families pinned so the tests know exactly which pool each example task lands in. */
export const PINNED = {
  "csv-aggregation": "train",
  "text-cleaning": "train", // redact-notes: task.holdout = true, so it never trains anyway
  "data-cleaning": "dev",
  "json-transform": "holdout",
  "log-analysis": "canary",
} as const;

export const pinnedPools = () => new PoolManager({ salt: SALT, pinned: { ...PINNED } });

/**
 * Runs a task's reference solution (or wrong answer) against a fake tool API
 * that serves the task's visible files and records what gets written.
 */
export async function recordSolution(task: Task, which: "solve" | "writeWrongAnswer" = "solve"): Promise<{ reads: string[]; writes: [string, string][] }> {
  const reads: string[] = [];
  const writes: [string, string][] = [];
  const tools: ToolAPI = {
    listFiles: async () => Object.keys(task.files).sort(),
    readFile: async (p: string) => {
      reads.push(p);
      const c = task.files[p];
      if (c === undefined) throw new Error(`no such file ${p}`);
      return c;
    },
    writeFile: async (p: string, c: string) => {
      writes.push([p, c]);
    },
    deleteFile: async () => {},
    runCheck: async (): Promise<GradeResult> => ({ pass: true, score: 1, details: "" }),
    think: () => {},
    submit: () => {},
  };
  const fn = task[which];
  if (!fn) throw new Error(`task ${task.id} has no ${which}`);
  await fn.call(task, tools);
  return { reads, writes };
}
