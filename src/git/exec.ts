import { execFileSync } from "node:child_process";

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly stderr: string,
    public readonly code: number,
  ) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
    this.name = "GitError";
  }
}

export interface GitOptions {
  cwd?: string;
  /** Throw GitError on nonzero exit (default true). */
  check?: boolean;
  env?: Record<string, string>;
  /** Piped to git's stdin (e.g. hash-object --stdin). */
  input?: string;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Shell out to the system git. Deliberately NOT a git library: credential
 * helpers and SSH agents are memfed's entire auth model (RFC §6.2).
 */
export function git(args: string[], opts: GitOptions = {}): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      input: opts.input,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr: "", code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    const result: GitResult = {
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? (e as Error).message),
      code: err.status ?? 1,
    };
    if (opts.check !== false) throw new GitError(args, result.stderr, result.code);
    return result;
  }
}

export function revParse(cwd: string, ref: string): string | undefined {
  const r = git(["rev-parse", "--verify", "--quiet", ref], { cwd, check: false });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return (
    git(["merge-base", "--is-ancestor", ancestor, descendant], { cwd, check: false }).code === 0
  );
}

export function aheadCount(cwd: string, upstream: string, branch = "HEAD"): number {
  const r = git(["rev-list", "--count", `${upstream}..${branch}`], { cwd, check: false });
  return r.code === 0 ? Number(r.stdout.trim()) : 0;
}

export function changedFiles(cwd: string, from: string, to: string): string[] {
  const r = git(["diff", "--name-status", from, to], { cwd });
  return r.stdout.split("\n").filter(Boolean);
}

export function sleepJitter(attempt: number): void {
  const ms = 120 * attempt + Math.floor(Math.random() * 250);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Push main with the standard fetch/rebase/retry loop (RFC §8). */
export function pushMainWithRetry(dir: string, what: string): void {
  let lastError = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const push = git(["push", "-q", "origin", "main"], { cwd: dir, check: false });
    if (push.code === 0) return;
    lastError = push.stderr;
    if (attempt === 4) break;
    git(["fetch", "-q", "origin"], { cwd: dir });
    const rebase = git(["rebase", "origin/main"], { cwd: dir, check: false });
    if (rebase.code !== 0) {
      git(["rebase", "--abort"], { cwd: dir, check: false });
      throw new GitError(["push"], `rebase conflict while pushing ${what}`, 1);
    }
    sleepJitter(attempt);
  }
  throw new GitError(["push"], `push of ${what} failed after retries: ${lastError.trim()}`, 1);
}
