import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isExpired, type PresenceEntry } from "../../src/git/presence.js";

const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
const CLI = "src/cli/index.ts";

let root: string;
let teamRemote: string;
let orgRemote: string;
let alice: NodeJS.ProcessEnv;
let bob: NodeJS.ProcessEnv;

function personaEnv(name: string): NodeJS.ProcessEnv {
  const gitconfig = join(root, `${name}.gitconfig`);
  writeFileSync(gitconfig, `[user]\n\tname = ${name}\n\temail = ${name}@demo.local\n`);
  return {
    ...process.env,
    MEMFED_HOME: join(root, `${name}-memfed`),
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

function runFail(
  env: NodeJS.ProcessEnv,
  args: string[],
): { code: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync(tsx, [CLI, ...args], {
      encoding: "utf8",
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stderr: "", stdout };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer | string; stdout?: Buffer | string };
    return {
      code: err.status ?? -1,
      stderr: String(err.stderr ?? ""),
      stdout: String(err.stdout ?? ""),
    };
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "memfed-t2-"));
  teamRemote = join(root, "team.git");
  orgRemote = join(root, "org.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", teamRemote]);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", orgRemote]);
  alice = personaEnv("alice");
  bob = personaEnv("bob");
  run(alice, ["init"]);
  run(bob, ["init"]);
  run(alice, [
    "space",
    "init",
    `file://${teamRemote}`,
    "--name",
    "team",
    "--kind",
    "team",
    "--policy",
    "direct",
  ]);
  run(alice, [
    "space",
    "init",
    `file://${orgRemote}`,
    "--name",
    "org",
    "--kind",
    "org",
    "--policy",
    "direct",
  ]);
  run(bob, ["space", "add", `file://${teamRemote}`]);
  run(bob, ["space", "add", `file://${orgRemote}`]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("promote (project/team -> org)", () => {
  let id: string;

  it("bob promotes ALICE's team record to the org space — non-authors may promote", () => {
    const out = run(alice, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "convention",
      "--title",
      "Service names use kebab-case",
      "--body",
      "All deployables are kebab-case in CI and infra configs.",
    ]);
    id = out.match(/created (\S+)/)?.[1] as string;
    run(alice, ["share", id, "--to", "team", "--yes"]);
    run(bob, ["sync"]);

    const promoted = run(bob, ["promote", id, "--to", "org"]);
    expect(promoted).toContain("promoted");

    const tree = execFileSync(
      "git",
      ["--git-dir", orgRemote, "ls-tree", "-r", "--name-only", "main"],
      {
        encoding: "utf8",
      },
    );
    expect(tree).toContain(`records/${id}.md`);

    // Provenance preserved; promoter attributed.
    const file = execFileSync("git", ["--git-dir", orgRemote, "show", `main:records/${id}.md`], {
      encoding: "utf8",
    });
    expect(file).toContain("author: alice@demo.local");
    expect(file).toContain(`promoted_from: team/${id}`);
    expect(file).toContain("promoted_by: bob@demo.local");
  });

  it("refuses to promote private, already-promoted, or non-active records", () => {
    const priv = run(bob, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "gotcha",
      "--title",
      "Private only",
      "--body",
      "Not published anywhere.",
    ]).match(/created (\S+)/)?.[1] as string;
    expect(runFail(bob, ["promote", priv, "--to", "org"]).stderr).toContain("not published");
    expect(runFail(bob, ["promote", id, "--to", "org"]).stderr).toContain("already published");
  });
});

describe("presence layer 2", () => {
  it("alice publishes a fixed-schema presence entry; bob sees it in show and brief", () => {
    const out = run(alice, [
      "presence",
      "set",
      "--space",
      "team",
      "--note",
      "refactoring payments webhooks",
      "--areas",
      "payments,webhooks",
      "--project",
      "payments-api",
    ]);
    expect(out).toContain("presence published");

    const show = run(bob, ["presence", "show", "--space", "team"]);
    expect(show).toContain("refactoring payments webhooks");
    expect(show).toContain("alice");

    const brief = run(bob, ["brief", "--project", "payments-api"]);
    expect(brief).toContain("refactoring payments webhooks");
    expect(brief).toContain("OVERLAP");
  });

  it("rejects notes >100 chars and path-shaped areas (the schema is the consent boundary)", () => {
    expect(
      runFail(alice, ["presence", "set", "--space", "team", "--note", "x".repeat(101)]).stderr,
    ).toContain("100");
    expect(
      runFail(alice, ["presence", "set", "--space", "team", "--note", "ok", "--areas", "src/auth"])
        .stderr,
    ).toContain("never file paths");
  });

  it("prune-presence squashes the branch to a single commit and keeps entries", () => {
    run(alice, ["presence", "set", "--space", "team", "--note", "second update"]);
    const countBefore = execFileSync(
      "git",
      ["--git-dir", teamRemote, "rev-list", "--count", "presence"],
      { encoding: "utf8" },
    ).trim();
    expect(Number(countBefore)).toBeGreaterThan(1);

    const pruned = run(alice, ["space", "prune-presence", "--space", "team"]);
    expect(pruned).toContain("pruned");
    const countAfter = execFileSync(
      "git",
      ["--git-dir", teamRemote, "rev-list", "--count", "presence"],
      { encoding: "utf8" },
    ).trim();
    expect(countAfter).toBe("1");

    const show = run(bob, ["presence", "show", "--space", "team"]);
    expect(show).toContain("second update");
  });

  it("expiry semantics: entries past updated+ttl render as absent (pure check)", () => {
    const stale: PresenceEntry = {
      author: "x@demo.local",
      name: "x",
      areas: [],
      note: "old",
      updated: "2026-07-13T00:00:00Z",
      ttl_hours: 24,
    };
    expect(isExpired(stale, Date.parse("2026-07-15T01:00:00Z"))).toBe(true);
    expect(
      isExpired({ ...stale, updated: "2026-07-14T23:00:00Z" }, Date.parse("2026-07-15T01:00:00Z")),
    ).toBe(false);
    // ttl is capped at 48h no matter what the file claims:
    expect(isExpired({ ...stale, ttl_hours: 9999 }, Date.parse("2026-07-18T00:00:00Z"))).toBe(true);
  });
});

describe("lint-space (CI backstop)", () => {
  it("fails on a secret that bypassed the client gate; lint-allow suppresses reviewed findings", () => {
    // Simulate a hacked/bypassing client: write a dirty record straight into a clone.
    const evil = mkdtempSync(join(tmpdir(), "memfed-evilclone-"));
    try {
      execFileSync("git", ["clone", "-q", `file://${teamRemote}`, evil], { env: alice });
      const badId = "01JZX5M8Q0V7T3E9RWN2K4YHZZ";
      writeFileSync(
        join(evil, "records", `${badId}.md`),
        `---\nid: ${badId}\ntitle: Deploy notes\ntype: runbook\nproject: payments-api\nprovenance:\n  author: alice@demo.local\n  tool: manual\n  created: 2026-07-15T00:00:00Z\nstatus: active\nschema_version: 1\n---\n\nUse key AKIAIOSFODNN7EXAMPLE for the deploy.\n`,
      );
      const fail = runFail(alice, ["lint-space", "--dir", evil]);
      expect(fail.code).toBe(1);
      expect(fail.stderr).toContain("aws-access-key-id");

      // Reviewer accepts it as a false positive via the space allowlist:
      const fingerprint = fail.stderr.match(/aws-access-key-id:([0-9a-f]{32})/)?.[1];
      expect(fingerprint).toBeTruthy();
      writeFileSync(join(evil, ".memfed", "lint-allow"), `aws-access-key-id:${fingerprint}\n`);
      const ok = runFail(alice, ["lint-space", "--dir", evil]);
      expect(ok.code).toBe(0);
    } finally {
      rmSync(evil, { recursive: true, force: true });
    }
  });

  it("space init ships the CI workflow", () => {
    const tree = execFileSync(
      "git",
      ["--git-dir", teamRemote, "ls-tree", "-r", "--name-only", "main"],
      {
        encoding: "utf8",
      },
    );
    expect(tree).toContain(".github/workflows/memfed-lint.yml");
  });
});

describe("connect claude --hook", () => {
  it("writes a SessionStart hook that runs the brief", () => {
    const proj = join(root, "proj");
    execFileSync("mkdir", ["-p", proj]);
    writeFileSync(join(proj, ".memfed.yaml"), "project: payments-api\nspaces:\n  - team\n");
    run(bob, ["connect", "claude", "--project", proj, "--hook"]);
    const settings = JSON.parse(readFileSync(join(proj, ".claude", "settings.json"), "utf8"));
    const hook = settings.hooks.SessionStart[0];
    expect(hook.matcher).toBe("startup|resume|clear");
    expect(hook.hooks[0].command).toContain("brief");
    // Idempotent: reconnecting doesn't duplicate the hook.
    run(bob, ["connect", "claude", "--project", proj, "--hook"]);
    const again = JSON.parse(readFileSync(join(proj, ".claude", "settings.json"), "utf8"));
    expect(again.hooks.SessionStart).toHaveLength(1);
  });
});

describe("gardening", () => {
  it("lists published records whose review_after has passed", () => {
    const out = run(alice, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "gotcha",
      "--title",
      "Old gotcha needing review",
      "--body",
      "This aged out.",
    ]);
    const id = out.match(/created (\S+)/)?.[1] as string;
    run(alice, ["share", id, "--to", "team", "--yes"]);

    // Age the space copy's metadata (a metadata edit any member could PR) and reindex.
    const cloneFile = join(String(alice.MEMFED_HOME), "spaces", "team", "records", `${id}.md`);
    const text = readFileSync(cloneFile, "utf8");
    writeFileSync(
      cloneFile,
      text.replace("status: active", "status: active\nreview_after: 2026-01-01"),
    );
    run(alice, ["reindex", "--full"]);

    const garden = run(alice, ["gardening", "--space", "team"]);
    expect(garden).toContain("Old gotcha needing review");
    expect(garden).toContain("review overdue since 2026-01-01");
  });
});
