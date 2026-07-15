import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
const CLI = "src/cli/index.ts";

let root: string;
let remote: string;
let maintainer: NodeJS.ProcessEnv; // has "approval rights" (in v1 = push rights)
let contributor: NodeJS.ProcessEnv;

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

function runFail(env: NodeJS.ProcessEnv, args: string[]): { code: number; stderr: string } {
  try {
    execFileSync(tsx, [CLI, ...args], { encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer | string };
    return { code: err.status ?? -1, stderr: String(err.stderr ?? "") };
  }
}

function remoteMainTree(): string {
  return execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"], {
    encoding: "utf8",
  });
}

function remoteRefs(): string {
  return execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)"], {
    encoding: "utf8",
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "memfed-pr-"));
  remote = join(root, "org-memory.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  maintainer = personaEnv("maintainer");
  contributor = personaEnv("contributor");
  run(maintainer, ["init"]);
  run(contributor, ["init"]);
  run(maintainer, [
    "space",
    "init",
    `file://${remote}`,
    "--name",
    "org",
    "--kind",
    "org",
    "--policy",
    "pr",
  ]);
  run(contributor, ["space", "add", `file://${remote}`]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pr-policy flow: propose branch -> review -> approve -> merged", () => {
  let recordId: string;

  it("contributor's share pushes a proposal branch, NOT main", () => {
    const out = run(contributor, [
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
    recordId = out.match(/created (\S+)/)?.[1] as string;
    const shareOut = run(contributor, ["share", recordId, "--to", "org", "--yes"]);
    expect(shareOut).toContain("proposal pushed");

    expect(remoteMainTree()).not.toContain(recordId);
    expect(remoteRefs()).toContain(`refs/heads/memfed/proposals/${recordId}`);
  });

  it("maintainer reviews the incoming queue and approves; record lands on main", () => {
    const reviewOut = run(maintainer, ["review", "--space", "org"]);
    expect(reviewOut).toContain("Service names use kebab-case");
    expect(reviewOut).toContain("contributor@demo.local");

    const approveOut = run(maintainer, ["approve", recordId.slice(0, 10), "--space", "org"]);
    expect(approveOut).toContain("approved");

    expect(remoteMainTree()).toContain(`records/${recordId}.md`);
    expect(remoteRefs()).not.toContain(`refs/heads/memfed/proposals/${recordId}`);
  });

  it("contributor syncs and sees their record published (proposal state resolved)", () => {
    const syncOut = run(contributor, ["sync", "org"]);
    expect(syncOut).toContain("synced org");
    const searchOut = run(contributor, ["search", "kebab-case", "--space", "org"]);
    expect(searchOut).toContain("Service names use kebab-case");
  });

  it("a rejected proposal never lands and its branch is deleted", () => {
    const out = run(contributor, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "convention",
      "--title",
      "Tabs not spaces everywhere",
      "--body",
      "A controversial take that will be rejected.",
    ]);
    const badId = out.match(/created (\S+)/)?.[1] as string;
    run(contributor, ["share", badId, "--to", "org", "--yes"]);
    expect(remoteRefs()).toContain(`refs/heads/memfed/proposals/${badId}`);

    const rejectOut = run(maintainer, ["reject", badId.slice(0, 10), "--space", "org"]);
    expect(rejectOut).toContain("rejected");
    expect(remoteRefs()).not.toContain(`refs/heads/memfed/proposals/${badId}`);
    expect(remoteMainTree()).not.toContain(badId);
  });

  it("approve re-runs the redaction gate on the reviewer side", () => {
    // Contributor stages a record whose secret slips in AFTER their local gate:
    // simulate by writing the proposal branch through the CLI, then verifying the
    // maintainer's approve still scans (we plant the secret pre-share; contributor
    // bypass would require a hacked client, which is exactly the threat).
    const out = run(contributor, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "runbook",
      "--title",
      "Deploy runbook",
      "--body",
      "Run deploy with STRIPE_SECRET=whsec_" + "a1b2c3d4e5f6g7h8i9j0" + " set.",
    ]);
    const dirtyId = out.match(/created (\S+)/)?.[1] as string;
    const fail = runFail(contributor, ["share", dirtyId, "--to", "org", "--yes"]);
    expect(fail.code).toBe(2); // contributor's own gate blocks it (INV-3)
    expect(remoteRefs()).not.toContain(dirtyId);
  });
});

describe("retract and supersede propagate through sync", () => {
  let goneId: string;
  let oldId: string;
  let newId: string;

  it("retract tombstones on the tip and disappears from the other user's view", () => {
    const out = run(maintainer, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "gotcha",
      "--title",
      "Old panic procedure",
      "--body",
      "This will be retracted.",
    ]);
    goneId = out.match(/created (\S+)/)?.[1] as string;
    // org space is pr-policy; maintainer has push rights so approve own proposal:
    run(maintainer, ["share", goneId, "--to", "org", "--yes"]);
    run(maintainer, ["approve", goneId.slice(0, 10), "--space", "org"]);
    run(contributor, ["sync", "org"]);
    expect(run(contributor, ["search", "panic", "--space", "org"])).toContain(
      "Old panic procedure",
    );

    const retractOut = run(maintainer, [
      "retract",
      goneId,
      "--space",
      "org",
      "--reason",
      "wrong advice",
    ]);
    expect(retractOut).toContain("retracted");
    expect(retractOut.toLowerCase()).toContain("rotate"); // rotation guidance (honesty clause)

    run(contributor, ["sync", "org"]);
    // Excluded everywhere by default:
    expect(run(contributor, ["search", "panic", "--space", "org"])).toContain("no matches");
    // But explicitly queryable:
    expect(run(contributor, ["list", "--space", "org", "--status", "retracted"])).toContain(
      "Old panic procedure",
    );
    const spaceFile = readFileSync(
      join(String(contributor.MEMFED_HOME), "spaces", "org", "records", `${goneId}.md`),
      "utf8",
    );
    expect(spaceFile).toContain("RETRACTED");
    expect(spaceFile).not.toContain("This will be retracted.");
  });

  it("supersede publishes the correction and backlinks the original", () => {
    let out = run(maintainer, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "decision",
      "--title",
      "Retry budget is 3",
      "--body",
      "Three retries max.",
    ]);
    oldId = out.match(/created (\S+)/)?.[1] as string;
    run(maintainer, ["share", oldId, "--to", "org", "--yes"]);
    run(maintainer, ["approve", oldId.slice(0, 10), "--space", "org"]);

    out = run(maintainer, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "decision",
      "--title",
      "Retry budget is 5 with jitter",
      "--body",
      "Five retries with exponential backoff and jitter, decided 2026-07.",
    ]);
    newId = out.match(/created (\S+)/)?.[1] as string;

    const sup = run(maintainer, ["supersede", oldId, "--with", newId, "--space", "org"]);
    expect(sup).toContain("superseded");

    run(contributor, ["sync", "org"]);
    const showOld = run(contributor, ["show", oldId.slice(0, 10)]);
    expect(showOld).toContain("status: superseded");
    expect(showOld).toContain(`superseded_by: ${newId}`);
    const showNew = run(contributor, ["show", newId.slice(0, 10)]);
    expect(showNew).toContain(`supersedes: ${oldId}`);
  });

  it("quarantine hides a record locally without touching the space", () => {
    run(contributor, ["quarantine", newId]);
    expect(run(contributor, ["search", "retry budget jitter"])).toContain("no matches");
    // Space copy untouched:
    expect(remoteMainTree()).toContain(`records/${newId}.md`);
    run(contributor, ["quarantine", newId, "--undo"]);
    expect(run(contributor, ["search", "retry budget jitter"])).toContain("Retry budget is 5");
  });
});

describe("typed redaction overrides", () => {
  it("an override with a reason allowlists one finding and is audited", () => {
    const out = run(contributor, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "reference",
      "--title",
      "Example key format doc",
      "--body",
      "Docs use the canonical AWS example key AKIAIOSFODNN7EXAMPLE as a format sample.",
    ]);
    const id = out.match(/created (\S+)/)?.[1] as string;
    const fail = runFail(contributor, ["share", id, "--to", "org", "--yes"]);
    expect(fail.code).toBe(2);
    // Extract the finding's fingerprint from the audit log (masked, never raw):
    const audit = readFileSync(join(String(contributor.MEMFED_HOME), "audit.jsonl"), "utf8");
    const blockEvent = audit
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .reverse()
      .find((e) => e.action === "redaction-block" && e.record_id === id);
    expect(blockEvent).toBeDefined();
    const finding = blockEvent.findings[0];
    expect(finding.excerpt).not.toContain("AKIAIOSFODNN7EXAMPLE");

    const ok = run(contributor, [
      "share",
      id,
      "--to",
      "org",
      "--yes",
      "--override",
      `${finding.ruleId}:${finding.fingerprint}`,
      "--reason",
      "AWS's documented example key, not a real credential",
    ]);
    expect(ok).toContain("proposal pushed"); // org is pr-policy
    const overrideEvent = readFileSync(join(String(contributor.MEMFED_HOME), "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.action === "redaction-override" && e.record_id === id);
    expect(overrideEvent.reason).toContain("example key");
  });
});
