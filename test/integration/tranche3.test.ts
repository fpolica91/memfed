import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

function addRecord(
  env: NodeJS.ProcessEnv,
  title: string,
  body: string,
  extra: string[] = [],
): string {
  const out = run(env, [
    "add",
    "--project",
    "payments-api",
    "--type",
    "decision",
    "--title",
    title,
    "--body",
    body,
    ...extra,
  ]);
  return out.match(/created (\S+)/)?.[1] as string;
}

/** Edit a record file inside a persona's space clone and commit it there (raw git). */
function cloneEdit(
  env: NodeJS.ProcessEnv,
  space: string,
  id: string,
  mutate: (text: string) => string,
  message: string,
): void {
  const dir = join(String(env.MEMFED_HOME), "spaces", space);
  const file = join(dir, "records", `${id}.md`);
  writeFileSync(file, mutate(readFileSync(file, "utf8")));
  execFileSync("git", ["-C", dir, "add", `records/${id}.md`], { env });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message], { env });
}

function pushClone(env: NodeJS.ProcessEnv, space: string): void {
  const dir = join(String(env.MEMFED_HOME), "spaces", space);
  execFileSync("git", ["-C", dir, "push", "-q", "origin", "main"], { env });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "memfed-t3-"));
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

describe("field-wise conflict resolution during sync (RFC §8)", () => {
  it("metadata vs metadata: safety-precedence status wins, tags union, no parked draft", () => {
    const id = addRecord(alice, "Retry budget is three", "Three retries, no more.", [
      "--tags",
      "retries",
    ]);
    run(alice, ["share", id, "--to", "team", "--yes"]);
    run(bob, ["sync", "team"]);

    // Alice pushes a tag addition to the remote…
    cloneEdit(
      alice,
      "team",
      id,
      (t) => t.replace("  - retries", "  - backoff\n  - retries"),
      "add tag",
    );
    pushClone(alice, "team");
    // …while bob commits a status change locally, without syncing first.
    cloneEdit(
      bob,
      "team",
      id,
      (t) => t.replace("status: active", "status: deprecated"),
      "deprecate",
    );

    const out = run(bob, ["sync", "team"]);
    expect(out).toContain("synced team");

    const merged = readFileSync(
      join(String(bob.MEMFED_HOME), "spaces", "team", "records", `${id}.md`),
      "utf8",
    );
    expect(merged).toContain("status: deprecated"); // precedence over active
    expect(merged).toContain("- backoff"); // remote tag kept
    expect(merged).toContain("- retries");

    // Bob's resolution was pushed; alice sees it after her own sync.
    run(alice, ["sync", "team"]);
    const aliceCopy = readFileSync(
      join(String(alice.MEMFED_HOME), "spaces", "team", "records", `${id}.md`),
      "utf8",
    );
    expect(aliceCopy).toContain("status: deprecated");

    // No divergent bodies => no parked conflict draft.
    expect(run(bob, ["list", "--status", "candidate"])).not.toContain("conflict draft");
  });

  it("body vs body: remote wins, local body parked as a private conflict-of draft", () => {
    const id = addRecord(alice, "Webhook timeout", "Timeout is 30 seconds.");
    run(alice, ["share", id, "--to", "team", "--yes"]);
    run(bob, ["sync", "team"]);

    cloneEdit(
      alice,
      "team",
      id,
      (t) => t.replace("30 seconds", "45 seconds (remote truth)"),
      "remote edit",
    );
    pushClone(alice, "team");
    cloneEdit(
      bob,
      "team",
      id,
      (t) => t.replace("30 seconds", "60 seconds (local truth)"),
      "local edit",
    );

    run(bob, ["sync", "team"]);

    const merged = readFileSync(
      join(String(bob.MEMFED_HOME), "spaces", "team", "records", `${id}.md`),
      "utf8",
    );
    expect(merged).toContain("45 seconds (remote truth)");
    expect(merged).not.toContain("60 seconds (local truth)");

    // The losing local body is parked privately for a human.
    const drafts = run(bob, ["list", "--status", "candidate"]);
    expect(drafts).toContain("conflict draft: Webhook timeout");
    const search = run(bob, ["search", "local", "truth", "--space", "local"]);
    expect(search).toContain("conflict draft");
  });
});

describe("suggest (RFC §7.3 candidate detection)", () => {
  it("suggests only clean, shareable, unpublished records; --propose stages them", () => {
    const goodId = addRecord(bob, "Card tokens are single-use", "Vault tokens burn on first use.");
    addRecord(bob, "My dirty runbook", "Use STRIPE_SECRET=whsec_abcdef1234567890xyz to deploy.");
    run(bob, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "preference",
      "--title",
      "I like tabs",
      "--body",
      "Personal preference only.",
    ]);
    run(bob, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "gotcha",
      "--title",
      "My local scratch path",
      "--body",
      "Notes live in /home/bob/scratch/notes.md",
    ]);

    const out = run(bob, ["suggest", "--project", "payments-api"]);
    expect(out).toContain("Card tokens are single-use");
    expect(out).not.toContain("My dirty runbook"); // redaction-dirty veto
    expect(out).not.toContain("I like tabs"); // type veto
    expect(out).not.toContain("My local scratch path"); // personal-context veto

    const proposed = run(bob, [
      "suggest",
      "--project",
      "payments-api",
      "--propose",
      "--to",
      "team",
    ]);
    expect(proposed).toContain("staged 1 proposal");
    const review = run(bob, ["review"]);
    expect(review).toContain(goodId.slice(0, 10));

    // Idempotent: an open proposal removes it from further suggestions.
    expect(run(bob, ["suggest", "--project", "payments-api"])).not.toContain(
      "Card tokens are single-use",
    );
  });
});

describe("status (RFC §6.4 promotion drift)", () => {
  it("reports store/queue/spaces and flags a record whose copies diverged across spaces", () => {
    const id = addRecord(alice, "Ledger is append-only", "Never mutate ledger rows.");
    run(alice, ["share", id, "--to", "team", "--yes"]);
    run(alice, ["promote", id, "--to", "org"]);
    // Copies agree — no drift yet.
    expect(run(alice, ["status"])).not.toContain("drift");

    run(alice, ["retract", id, "--space", "team", "--reason", "superseded by new ledger design"]);
    const status = run(alice, ["status"]);
    expect(status).toContain("drift");
    expect(status).toContain("team:retracted");
    expect(status).toContain("org:active");
    expect(status).toContain("private store");
    expect(status).toContain("space team");
  });
});
