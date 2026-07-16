import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
const CLI = "src/cli/index.ts";

let root: string;
let codeRemote: string;
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

function remoteTree(ref = "main"): string {
  return execFileSync("git", ["--git-dir", codeRemote, "ls-tree", "-r", "--name-only", ref], {
    encoding: "utf8",
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "memfed-inrepo-"));
  codeRemote = join(root, "payments-api.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", codeRemote]);
  alice = personaEnv("alice");
  bob = personaEnv("bob");
  run(alice, ["init"]);
  run(bob, ["init"]);

  // Seed the "code project": this repo exists long before memfed shows up.
  const seed = join(root, "seed");
  execFileSync("git", ["clone", "-q", `file://${codeRemote}`, seed], { env: alice });
  mkdirSync(join(seed, "src"), { recursive: true });
  writeFileSync(join(seed, "src", "app.ts"), "export const app = () => 'payments';\n");
  writeFileSync(join(seed, "README.md"), "# payments-api\nThe code project README.\n");
  execFileSync("git", ["-C", seed, "add", "-A"], { env: alice });
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "code: initial app"], { env: alice });
  execFileSync("git", ["-C", seed, "push", "-q", "-u", "origin", "main"], { env: alice });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("in-repo spaces (RFC §6.3 root:)", () => {
  let aliceRecordId: string;

  it("space init --root adds the space INSIDE the code repo without touching code files", () => {
    const out = run(alice, [
      "space",
      "init",
      `file://${codeRemote}`,
      "--name",
      "payments-mem",
      "--root",
      ".memory",
      "--kind",
      "team",
      "--policy",
      "direct",
    ]);
    expect(out).toContain("in-repo at .memory/");

    const tree = remoteTree();
    expect(tree).toContain("src/app.ts"); // host code untouched
    expect(tree).toContain(".memory/.memfed/space.yaml");
    expect(tree).toContain(".memory/records/.gitkeep");
    expect(tree).not.toContain(".github/workflows/memfed-lint.yml"); // never touch host CI
    // Host README not overwritten:
    const readme = execFileSync("git", ["--git-dir", codeRemote, "show", "main:README.md"], {
      encoding: "utf8",
    });
    expect(readme).toContain("The code project README");
  });

  it("publish lands under .memory/records/", () => {
    const out = run(alice, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "decision",
      "--title",
      "Refunds settle within 5 days",
      "--body",
      "Refund settlement SLA is five business days.",
    ]);
    aliceRecordId = out.match(/created (\S+)/)?.[1] as string;
    run(alice, ["share", aliceRecordId, "--to", "payments-mem", "--yes"]);
    expect(remoteTree()).toContain(`.memory/records/${aliceRecordId}.md`);
  });

  it("space add auto-discovers the root and joins with a sparse checkout", () => {
    const out = run(bob, ["space", "add", `file://${codeRemote}`]);
    expect(out).toContain("joined space payments-mem");
    expect(out).toContain("1 record");

    const clone = join(String(bob.MEMFED_HOME), "spaces", "payments-mem");
    expect(existsSync(join(clone, ".memory", "records", `${aliceRecordId}.md`))).toBe(true);
    expect(existsSync(join(clone, "src"))).toBe(false); // monorepo code not materialized

    const search = run(bob, ["search", "refund", "settlement"]);
    expect(search).toContain("Refunds settle within 5 days");
  });

  it("bob publishes back; alice syncs it in (rooted incremental reindex)", () => {
    const out = run(bob, [
      "add",
      "--project",
      "payments-api",
      "--type",
      "gotcha",
      "--title",
      "Sandbox refunds are instant",
      "--body",
      "The sandbox settles refunds immediately; do not use it for SLA tests.",
    ]);
    const bobId = out.match(/created (\S+)/)?.[1] as string;
    run(bob, ["share", bobId, "--to", "payments-mem", "--yes"]);
    expect(remoteTree()).toContain(`.memory/records/${bobId}.md`);

    run(alice, ["sync", "payments-mem"]);
    expect(run(alice, ["search", "sandbox", "refunds"])).toContain("Sandbox refunds are instant");
  });

  it("code commits flow through sync without disturbing the space", () => {
    const seed2 = join(root, "seed2");
    execFileSync("git", ["clone", "-q", `file://${codeRemote}`, seed2], { env: alice });
    writeFileSync(join(seed2, "src", "app.ts"), "export const app = () => 'payments v2';\n");
    execFileSync("git", ["-C", seed2, "add", "-A"], { env: alice });
    execFileSync("git", ["-C", seed2, "commit", "-q", "-m", "code: v2"], { env: alice });
    execFileSync("git", ["-C", seed2, "push", "-q"], { env: alice });

    const out = run(bob, ["sync", "payments-mem"]);
    expect(out).toContain("synced payments-mem");
    expect(run(bob, ["search", "refund", "settlement"])).toContain("Refunds settle within 5 days");
  });

  it("retract works with rooted paths and propagates", () => {
    run(alice, ["retract", aliceRecordId, "--space", "payments-mem", "--reason", "SLA changed"]);
    run(bob, ["sync", "payments-mem"]);
    expect(run(bob, ["search", "refund", "settlement"])).toContain("no matches");
    const stub = execFileSync(
      "git",
      ["--git-dir", codeRemote, "show", `main:.memory/records/${aliceRecordId}.md`],
      { encoding: "utf8" },
    );
    expect(stub).toContain("RETRACTED");
  });

  it("presence files live under the root on the presence branch", () => {
    run(alice, [
      "presence",
      "set",
      "--space",
      "payments-mem",
      "--note",
      "migrating refunds service",
      "--areas",
      "refunds",
    ]);
    const presenceTree = execFileSync(
      "git",
      ["--git-dir", codeRemote, "ls-tree", "-r", "--name-only", "presence"],
      { encoding: "utf8" },
    );
    expect(presenceTree).toContain(".memory/presence/alice.md");
    const show = run(bob, ["presence", "show", "--space", "payments-mem"]);
    expect(show).toContain("migrating refunds service");
  });

  it("lint-space auto-discovers the in-repo root from the host repo checkout", () => {
    const ci = join(root, "ci-checkout");
    execFileSync("git", ["clone", "-q", `file://${codeRemote}`, ci], { env: alice });
    const out = execFileSync(tsx, [CLI, "lint-space", "--dir", ci], {
      encoding: "utf8",
      env: alice,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(out).toContain("lint-space: 2 record(s)");
    expect(out).toContain("0 block(s)");
  });
});
