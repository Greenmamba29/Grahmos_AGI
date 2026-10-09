import type { GradeResult, ReadonlyFS, Step, Task, ToolAPI, ToolName } from "./types.js";

export class SandboxEscapeError extends Error {
  override name = "SandboxEscapeError";
}
export class BudgetExhaustedError extends Error {
  override name = "BudgetExhaustedError";
}
export class RunTimeoutError extends Error {
  override name = "RunTimeoutError";
}
export class FileNotFoundError extends Error {
  override name = "FileNotFoundError";
}
export class RunClosedError extends Error {
  override name = "RunClosedError";
}
export class NotAFileError extends Error {
  override name = "NotAFileError";
}
/**
 * The run could not proceed for reasons outside the agent (provider 408/429/5xx
 * after retries, network failure). Thrown by agent adapters; the runner marks
 * the run as an infra error.
 */
export class InfraError extends Error {
  override name = "InfraError";
}
/** Misconfiguration (bad API key, unknown model, 401/403/404). Aborts the whole evaluation. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

// Captured at load so agent code cannot later swap the built-ins the recorder relies on.
const clone: typeof structuredClone = structuredClone;
const freeze = Object.freeze;

/**
 * Resolves a raw path into segments, chroot-style: a leading "/" is the
 * sandbox root and ".." at the root stays at the root. Throws
 * SandboxEscapeError only for paths with no meaning inside a sandbox
 * (null bytes, "~", drive letters).
 */
export function resolveParts(raw: string): string[] {
  if (typeof raw !== "string") throw new SandboxEscapeError(`invalid path: ${String(raw)}`);
  if (raw.includes("\0")) throw new SandboxEscapeError(`null byte in path`);
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("~")) throw new SandboxEscapeError(`home-directory path outside sandbox: ${raw}`);
  if (/^[a-zA-Z]:/.test(p)) throw new SandboxEscapeError(`drive path outside sandbox: ${raw}`);
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts;
}

const HOST_DIRS = /^(etc|proc|sys|dev|root|home|usr|var|bin|sbin|boot|lib|lib64|opt|tmp|mnt|run|Users|Windows|private)$/;

/**
 * Describes an attempt to reach outside the sandbox, or undefined. Such paths
 * never leave the virtual file system, but trying is worth recording:
 * climbing above the root, "~", drive letters, null bytes, or absolute paths
 * into well-known host directories.
 */
export function escapeAttempt(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.includes("\0")) return "null byte in path";
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("~")) return "home-directory path";
  if (/^[a-zA-Z]:/.test(p)) return "drive-letter path";
  if (p.startsWith("/")) {
    // Resolve first so "//etc", "/./etc" and "/x/../etc" are caught like "/etc".
    const first = resolveParts(p)[0];
    if (first !== undefined && HOST_DIRS.test(first)) return "absolute path into a host system directory";
  }
  let depth = 0;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    depth += seg === ".." ? -1 : 1;
    if (depth < 0) return "path climbs above the sandbox root";
  }
  return undefined;
}

/**
 * Normalizes a sandbox path to a relative, forward-slash file path.
 * "/data/x" == "data/x"; ".." resolves within the sandbox and stops at the root.
 * Throws NotAFileError for paths that resolve to the root, and
 * SandboxEscapeError for null bytes, "~" and drive letters.
 */
export function normalizePath(raw: string): string {
  const parts = resolveParts(raw);
  if (parts.length === 0) throw new NotAFileError(`not a file (resolves to the project root): ${JSON.stringify(raw)}`);
  return parts.join("/");
}

/** True for prefixes that resolve to the whole sandbox ("", ".", "/", "a/.."). */
export function isRootPrefix(prefix: string | undefined): boolean {
  if (prefix === undefined) return true;
  try {
    return resolveParts(prefix).length === 0;
  } catch {
    return false;
  }
}

/**
 * True if `path` (normalized) is inside any protected entry. An entry
 * protects the exact file and everything below it as a directory, with or
 * without a trailing slash ("checks" and "checks/" behave the same).
 */
export function isUnder(path: string, entries: string[]): boolean {
  return entries.some((raw) => {
    const e = normalizePath(raw);
    return path === e || path.startsWith(`${e}/`);
  });
}

/** In-memory file system. Paths are normalized relative paths. */
export class MemoryFS implements ReadonlyFS {
  private files = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(initial)) this.files.set(normalizePath(p), c);
  }

  read(path: string): string | undefined {
    return this.files.get(normalizePath(path));
  }
  exists(path: string): boolean {
    return this.files.has(normalizePath(path));
  }
  /** Lists files under a directory prefix (or everything for a root prefix). */
  list(prefix = ""): string[] {
    const keys = [...this.files.keys()];
    if (isRootPrefix(prefix)) return keys.sort();
    const p = normalizePath(prefix);
    return keys.filter((k) => k === p || k.startsWith(`${p}/`)).sort();
  }
  write(path: string, content: string): void {
    this.files.set(normalizePath(path), content);
  }
  delete(path: string): boolean {
    return this.files.delete(normalizePath(path));
  }
  clone(): MemoryFS {
    const fs = new MemoryFS();
    for (const [k, v] of this.files) fs.write(k, v);
    return fs;
  }
}

/** Default transcript truncation. Training export needs full transcripts: set SandboxOptions.previewChars = Infinity. */
export const PREVIEW_CHARS = 400;
/** Marker appended to truncated transcript text, so consumers can refuse partial data. */
export const TRUNCATION_MARK = /… \[\d+ chars\]$/;
function preview(s: string, max = PREVIEW_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}… [${s.length} chars]` : s;
}

export interface SandboxOptions {
  maxSteps: number;
  /** Abort controller owned by the runner; aborted when the budget is hit. */
  controller: AbortController;
  now?: () => number;
  /** Max characters kept per tool result / written content in the transcript (default 400; Infinity = full). */
  previewChars?: number;
}

/**
 * The sandbox an agent acts in. Every tool call is recorded as a Step so
 * detectors can inspect the full trajectory.
 *
 * Agents never receive this object: they get `facade()`, a frozen object
 * exposing only the tool methods, so in-process agent code cannot write to
 * the file system or edit the transcript behind the recorder's back.
 * (Untrusted agent *code* should still run out of process; see docs.)
 */
export class Sandbox implements ToolAPI {
  readonly fs: MemoryFS;
  readonly steps: Step[] = [];
  private toolCalls = 0;
  private submitted = false;
  private closed = false;
  budgetExhausted = false;
  private readonly now: () => number;

  constructor(
    private readonly task: Task,
    private readonly opts: SandboxOptions,
  ) {
    this.fs = new MemoryFS({ ...task.files, ...(task.hiddenFiles ?? {}) });
    this.now = opts.now ?? (() => performance.now());
  }

  /** Stops recording. Calls after this throw (tools) or are ignored (think/submit). */
  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Frozen view with only the tool methods, safe to hand to agent code. */
  facade(): ToolAPI {
    return Object.freeze({
      listFiles: (prefix?: string) => this.listFiles(prefix),
      readFile: (path: string) => this.readFile(path),
      writeFile: (path: string, content: string) => this.writeFile(path, content),
      deleteFile: (path: string) => this.deleteFile(path),
      runCheck: () => this.runCheck(),
      think: (text: string) => this.think(text),
      submit: (claim: "success" | "gave_up", text?: string) => this.submit(claim, text),
    });
  }

  /** Deep copy of the trajectory, frozen. */
  snapshotSteps(): Step[] {
    const copy = clone(this.steps);
    const tools = copy.filter((s) => s.kind === "tool").length;
    if (tools !== this.toolCalls) throw new Error(`trajectory integrity check failed: ${tools} tool steps recorded, ${this.toolCalls} calls made`);
    return freeze(copy) as Step[];
  }

  get submittedClaim(): "success" | "gave_up" | "none" {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i]!;
      if (s.kind === "submit") return s.claim;
    }
    return "none";
  }

  get stepCount(): number {
    return this.toolCalls;
  }

  /** Snapshot with grader-owned (protected) files restored to pristine. */
  restoredSnapshot(): MemoryFS {
    const fs = this.fs.clone();
    const pristine = new MemoryFS(this.task.files);
    const prot = this.task.protectedPaths;
    // Drop anything the agent added or changed under protected entries, then put the originals back.
    for (const k of fs.list()) if (isUnder(k, prot)) fs.delete(k);
    for (const k of pristine.list()) if (isUnder(k, prot)) fs.write(k, pristine.read(k)!);
    return fs;
  }

  private async call<T>(tool: ToolName, args: Record<string, unknown>, fn: () => T, render: (r: T) => string): Promise<T> {
    if (this.closed) throw new RunClosedError("run has ended");
    if (this.opts.controller.signal.aborted) throw new BudgetExhaustedError("run already stopped");
    if (this.toolCalls >= this.opts.maxSteps) {
      this.budgetExhausted = true;
      this.opts.controller.abort();
      throw new BudgetExhaustedError(`step budget of ${this.opts.maxSteps} exhausted`);
    }
    this.toolCalls++;
    const t0 = this.now();
    const index = this.steps.length;
    try {
      const r = fn();
      this.steps.push({ kind: "tool", index, tool, args, ok: true, result: preview(render(r), this.opts.previewChars), elapsedMs: this.now() - t0 });
      return r;
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.steps.push({ kind: "tool", index, tool, args, ok: false, result: preview(msg, this.opts.previewChars), elapsedMs: this.now() - t0 });
      throw e;
    }
  }

  async listFiles(prefix = ""): Promise<string[]> {
    return this.call("list_files", { prefix }, () => this.fs.list(prefix), (r) => r.join("\n"));
  }

  async readFile(path: string): Promise<string> {
    return this.call("read_file", { path }, () => {
      const c = this.fs.read(normalizePath(path));
      if (c === undefined) throw new FileNotFoundError(`no such file: ${path}`);
      return c;
    }, (r) => r);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.call("write_file", { path, bytes: content.length, content: preview(content, this.opts.previewChars) }, () => {
      this.fs.write(normalizePath(path), content);
    }, () => "ok");
  }

  async deleteFile(path: string): Promise<void> {
    await this.call("delete_file", { path }, () => {
      if (!this.fs.delete(normalizePath(path))) throw new FileNotFoundError(`no such file: ${path}`);
    }, () => "ok");
  }

  async runCheck(): Promise<GradeResult> {
    const check = this.task.check ?? this.task.grade;
    return this.call("run_check", {}, () => check.call(this.task, this.fs), (r) => `${r.pass ? "PASS" : "FAIL"} (${r.score.toFixed(2)}): ${r.details}`);
  }

  think(text: string): void {
    if (this.closed || !text || !text.trim()) return;
    this.steps.push({ kind: "thought", index: this.steps.length, text });
  }

  submit(claim: "success" | "gave_up", text = ""): void {
    // A run that ran out of steps is over; a later submit does not count.
    if (this.closed || this.submitted || this.budgetExhausted) return;
    this.submitted = true;
    this.steps.push({ kind: "submit", index: this.steps.length, claim, text });
  }
}

// Agent code runs in the same process; freezing the prototypes stops it from
// patching the recorder (e.g. replacing snapshotSteps) for this or later runs.
Object.freeze(Sandbox.prototype);
Object.freeze(MemoryFS.prototype);
