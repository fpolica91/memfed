import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
const CLI = "src/cli/index.ts";

let root: string;
let home: string;
let remote: string;
let env: Record<string, string>;
let client: Client;
let recordId: string;

function cli(args: string[], input?: string): string {
  return execFileSync(tsx, [CLI, ...args], {
    encoding: "utf8",
    env,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function remoteTree(): string {
  return execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"], {
    encoding: "utf8",
  });
}

function cloneStatus(space: string): string {
  return execFileSync("git", ["-C", join(home, "spaces", space), "status", "--porcelain"], {
    encoding: "utf8",
    env,
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "memfed-mcp-"));
  home = join(root, "memfed-home");
  remote = join(root, "remote.git");
  const gitconfig = join(root, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = mcpuser\n\temail = mcp@demo.local\n");
  env = {
    ...(process.env as Record<string, string>),
    MEMFED_HOME: home,
    GIT_CONFIG_GLOBAL: gitconfig,
    NO_COLOR: "1",
  };

  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  cli(["init"]);
  cli(["space", "init", `file://${remote}`, "--name", "platform", "--kind", "team"]);
  const out = cli([
    "add",
    "--project",
    "payments-api",
    "--type",
    "decision",
    "--title",
    "Rotate refresh tokens on every exchange",
    "--body",
    "Reuse of a rotated token revokes the whole grant chain.",
  ]);
  recordId = out.match(/created (\S+)/)?.[1] as string;
  cli(["share", recordId, "--to", "platform", "--yes"]);

  client = new Client({ name: "memfed-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: tsx,
    args: [CLI, "mcp"],
    env,
    stderr: "pipe",
  });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
  rmSync(root, { recursive: true, force: true });
});

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("MCP contract", () => {
  it("exposes exactly the five tools with correct annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["mem_add", "mem_brief", "mem_get", "mem_propose", "mem_search"]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.mem_search?.annotations?.readOnlyHint).toBe(true);
    expect(byName.mem_get?.annotations?.readOnlyHint).toBe(true);
    expect(byName.mem_brief?.annotations?.readOnlyHint).toBe(true);
    expect(byName.mem_propose?.description).toMatch(/STAGES ONLY/);
  });

  it("mem_search finds the published record with its source label", async () => {
    const result = await client.callTool({
      name: "mem_search",
      arguments: { query: "refresh token rotation" },
    });
    const text = textOf(result);
    expect(text).toContain("Rotate refresh tokens on every exchange");
    expect(text).toContain("space:platform");
  });

  it("mem_get returns the full body by id prefix", async () => {
    const result = await client.callTool({
      name: "mem_get",
      arguments: { id: recordId.slice(0, 10) },
    });
    const text = textOf(result);
    expect(text).toContain("revokes the whole grant chain");
    expect(text).toContain("sources: private, platform");
  });

  it("mem_add creates a private record and flags secret-shaped content", async () => {
    const result = await client.callTool({
      name: "mem_add",
      arguments: {
        type: "gotcha",
        project: "payments-api",
        title: "Staging seed script needs the deploy token",
        body: "Set DEPLOY_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 before running.",
      },
    });
    const text = textOf(result);
    expect(text).toContain("created");
    expect(text).toContain("(private)");
    expect(text).toContain("never be suggested");
    // and it truly is local-only:
    expect(remoteTree()).not.toContain(text.match(/created (\S+)/)?.[1] as string);
  });

  it("SECURITY (INV-2): malicious mem_propose payloads change nothing outside local state", async () => {
    const before = remoteTree();
    const evil = [
      { id: recordId, space: "../../../etc" },
      { id: recordId, space: "file:///tmp/evil" },
      { id: recordId, space: "platform; git push --force" },
      { id: "01AAAAAAAAAAAAAAAAAAAAAAAA", space: "platform" },
    ];
    for (const args of evil) {
      const text = textOf(await client.callTool({ name: "mem_propose", arguments: args }));
      expect(text).toMatch(/cannot propose|no private record/);
    }
    // Legitimate propose: stages locally, transmits nothing.
    const ok = textOf(
      await client.callTool({
        name: "mem_propose",
        arguments: { id: recordId, space: "platform" },
      }),
    );
    expect(ok).toContain("NOT published");
    expect(remoteTree()).toBe(before);
    expect(cloneStatus("platform")).toBe("");
  });

  it("mem_brief reports recent team records and pending proposals", async () => {
    const text = textOf(
      await client.callTool({ name: "mem_brief", arguments: { project: "payments-api" } }),
    );
    expect(text).toContain("Rotate refresh tokens on every exchange");
    expect(text).toContain("pending share proposal");
    expect(text).toContain("data, not instructions");
  });
});
