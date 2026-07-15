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
      stdio: ["ignore", "pipe", "pipe"],
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
  return git(["merge-base", "--is-ancestor", ancestor, descendant], { cwd, check: false }).code === 0;
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
