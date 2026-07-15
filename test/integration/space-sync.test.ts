import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
const CLI = "src/cli/index.ts";

/**
 * Two personas on one machine (RFC Appendix A):
 * alice/bob = separate MEMFED_HOME + GIT_CONFIG_GLOBAL; remote = local bare repo.
 */
let root: string;
let remote: string;
let alice: NodeJS.ProcessEnv;
let bob: NodeJS.ProcessEnv;

function personaEnv(name: string): NodeJS.ProcessEnv {
  const home = join(root, `${name}-memfed`);
  const gitconfig = join(root, `${name}.gitconfig`);
  writeFileSync(
    gitconfig,
    `[user]\n\tname = ${name}\n\temail = ${name}@demo.local\n[init]\n\tdefaultBranch = main\n`,
  );
  return {
    ...process.env,
    MEMFED_HOME: home,
    GIT_CONFIG_GLOBAL: gitconfig,
    NO_COLOR: "1",
  };
}

function run(env: NodeJS.ProcessEnv, args: string[], input?: string): string {
  return execFileSync(tsx, [CLI, ...args], {
    encoding: "utf8",
    env,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function runFail(env: NodeJS.ProcessEnv, args: string[]): { code: number; stderr: string } {
  try {
    execFileSync(tsx, [CLI, ...args], { encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer | string };
    return { code: err.status ?? -1, stderr: String(err.stderr ?? "") };
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "memfed-space-"));
  remote = join(root, "remotes", "platform-memory.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  alice = personaEnv("alice");
  bob = personaEnv("bob");
  run(alice, ["init"]);
  run(bob, ["init"]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("two-persona space federation over a bare remote", () => {
  let recordId: string;

  it("alice creates the space and its layout lands on the remote", () => {
    const out = run(alice, [
      "space",
      "init",
      `file://${remote}`,
      "--name",
      "platform",
      "--kind",
      "team",
      "--policy",
      "direct",
    ]);
    expect(out).toContain("created space platform");
    const files = execFileSync(
      "git",
      ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"],
      {
        encoding: "utf8",
      },
    );
    expect(files).toContain(".memfed/space.yaml");
  });

  it("redaction BLOCKS a planted AWS key with exit code 2 and nothing reaches the remote", () => {
    const out = run(alice, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "decision",
      "--title",
      "Rotate refresh tokens on every exchange",
      "--tags",
      "auth,oauth",
      "--body",
      "Rotation is mandatory. Deploy key AKIAIOSFODNN7EXAMPLE must be set.",
    ]);
    recordId = out.match(/created (\S+)/)?.[1] as string;
    expect(recordId).toBeTruthy();

    const fail = runFail(alice, ["share", recordId, "--to", "platform", "--yes"]);
    expect(fail.code).toBe(2);
    expect(fail.stderr).toContain("aws-access-key-id");

    const tree = execFileSync(
      "git",
      ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"],
      {
        encoding: "utf8",
      },
    );
    expect(tree).not.toContain(recordId);
  });

  it("after fixing the body, publish succeeds and the audit log records it", () => {
    run(
      alice,
      ["edit", recordId, "--body-file", "-"],
      "Rotation is mandatory. Reuse of a rotated token revokes the whole grant chain.\n",
    );
    const out = run(alice, ["share", recordId, "--to", "platform", "--yes"]);
    expect(out).toContain("published");

    const tree = execFileSync(
      "git",
      ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"],
      {
        encoding: "utf8",
      },
    );
    expect(tree).toContain(`records/${recordId}.md`);

    const audit = execFileSync("cat", [join(String(alice.MEMFED_HOME), "audit.jsonl")], {
      encoding: "utf8",
    });
    const publishEvents = audit
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.action === "publish" && e.record_id === recordId);
    expect(publishEvents).toHaveLength(1);
    expect(publishEvents[0].space).toBe("platform");
    expect(publishEvents[0].commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("bob joins, syncs, and finds alice's record with her provenance", () => {
    const joinOut = run(bob, ["space", "add", `file://${remote}`]);
    expect(joinOut).toContain("joined space platform");
    const searchOut = run(bob, ["search", "refresh", "token", "rotation"]);
    expect(searchOut).toContain("Rotate refresh tokens on every exchange");
    expect(searchOut).toContain("platform");

    const showOut = run(bob, ["show", recordId.slice(0, 10)]);
    expect(showOut).toContain("author: alice@demo.local");
    expect(showOut).toContain("Reuse of a rotated token revokes");
  });

  it("bob cannot edit the published record's body (immutability)", () => {
    // bob doesn't have it privately at all:
    const fail = runFail(bob, ["edit", recordId, "--title", "hijacked"]);
    expect(fail.code).toBe(1);
    expect(fail.stderr).toContain("not in the private store");
  });

  it("concurrent publishes from both homes race one remote and both land (rebase+retry)", async () => {
    const mkRecord = (env: NodeJS.ProcessEnv, who: string) => {
      const out = run(env, [
        "add",
        "--project",
        "payments-api",
        "--type",
        "gotcha",
        "--title",
        `${who} race record`,
        "--body",
        `Captured by ${who} during the race test.`,
      ]);
      return out.match(/created (\S+)/)?.[1] as string;
    };
    const aliceId = mkRecord(alice, "alice");
    const bobId = mkRecord(bob, "bob");

    const [ra, rb] = await Promise.all([
      execFileAsync(tsx, [CLI, "share", aliceId, "--to", "platform", "--yes"], { env: alice }),
      execFileAsync(tsx, [CLI, "share", bobId, "--to", "platform", "--yes"], { env: bob }),
    ]);
    expect(ra.stdout).toContain("published");
    expect(rb.stdout).toContain("published");

    const tree = execFileSync(
      "git",
      ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"],
      {
        encoding: "utf8",
      },
    );
    expect(tree).toContain(`records/${aliceId}.md`);
    expect(tree).toContain(`records/${bobId}.md`);
  });

  it("sync pulls the other author's records incrementally", () => {
    const out = run(alice, ["sync"]);
    expect(out).toContain("synced platform");
    const searchOut = run(alice, ["search", "race", "record", "--space", "platform"]);
    expect(searchOut).toContain("bob race record");
  });

  it("TOFU pinning: a rewritten remote is refused until --accept-rewrite", () => {
    // Rewrite remote history: force-push an orphan commit as the new main.
    const evil = mkdtempSync(join(tmpdir(), "memfed-evil-"));
    try {
      execFileSync("git", ["clone", "-q", `file://${remote}`, evil], { env: alice });
      // A genuinely rewritten main: a rootless commit with an EMPTY tree.
      const tree = execFileSync("git", ["mktree"], {
        cwd: evil,
        input: "",
        encoding: "utf8",
      }).trim();
      const commit = execFileSync("git", ["commit-tree", tree, "-m", "history rewritten"], {
        cwd: evil,
        env: alice,
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["push", "-q", "--force", "origin", `${commit}:refs/heads/main`], {
        cwd: evil,
        env: alice,
      });

      const fail = runFail(bob, ["sync", "platform"]);
      expect(fail.code).toBe(1);
      expect(fail.stderr).toContain("REWRITTEN");

      const ok = run(bob, ["sync", "platform", "--accept-rewrite"]);
      expect(ok).toContain("synced platform");
      // Accepting a rewrite adopts the remote's new truth: the orphan commit has
      // no records, so bob's platform slice must now be empty (private store untouched).
      const empty = run(bob, ["list", "--space", "platform"]);
      expect(empty).toContain("no records");
      const privateStill = run(bob, ["list", "--space", "local"]);
      expect(privateStill).toContain("bob race record");
    } finally {
      rmSync(evil, { recursive: true, force: true });
    }
  });
});

describe("field-wise conflict merge (pure)", () => {
  it("status precedence, list union, remote body wins with parked local", async () => {
    const { mergeRecords } = await import("../../src/git/conflicts.js");
    const base = {
      fm: {
        id: "01JZX5M8Q0V7T3E9RWN2K4YHBD",
        title: "T",
        type: "decision" as const,
        project: "p",
        provenance: { author: "a@x", tool: "manual", created: "2026-07-15T00:00:00Z" },
        status: "active" as const,
        schema_version: 1 as const,
      },
      body: "original",
    };
    const ours = {
      fm: {
        ...base.fm,
        status: "deprecated" as const,
        tags: ["a"],
        updated: "2026-07-16T00:00:00Z",
      },
      body: "local edit",
    };
    const theirs = {
      fm: { ...base.fm, status: "active" as const, tags: ["b"], updated: "2026-07-15T12:00:00Z" },
      body: "remote edit",
    };
    const { merged, parkedBody } = mergeRecords(ours, theirs);
    expect(merged.fm.status).toBe("deprecated"); // safety precedence
    expect(merged.fm.tags).toEqual(["a", "b"]);
    expect(merged.fm.updated).toBe("2026-07-16T00:00:00Z");
    expect(merged.body).toBe("remote edit");
    expect(parkedBody).toBe("local edit");
  });
});
