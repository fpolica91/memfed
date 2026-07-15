import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { saveConfig } from "../../core/config.js";
import { findProjectMarker, type ResolvedProject } from "../../core/project.js";
import { renderProject } from "../../render/targets.js";
import { CliError, type Ctx, openCtx } from "../util.js";

async function withCtx<T>(fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
  const ctx = await openCtx();
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

/**
 * How assistants should spawn the MCP server. Prefers a portable `memfed`
 * from PATH (safe to commit in .mcp.json); falls back to absolute paths for
 * dev checkouts running under tsx.
 */
export function mcpServerSpec(): { command: string; args: string[] } {
  try {
    execFileSync("which", ["memfed"], { stdio: ["ignore", "ignore", "ignore"] });
    return { command: "memfed", args: ["mcp"] };
  } catch {
    /* not on PATH */
  }
  const script = resolve(process.argv[1] ?? "");
  if (script.endsWith(".ts")) {
    const repoRoot = resolve(dirname(script), "..", "..");
    return { command: join(repoRoot, "node_modules", ".bin", "tsx"), args: [script, "mcp"] };
  }
  return { command: process.execPath, args: [script, "mcp"] };
}

function requireMarker(dir: string): ResolvedProject {
  const marker = findProjectMarker(dir);
  if (!marker)
    throw new CliError(
      `no .memfed.yaml found at or above ${dir} — create one at the repo root:\n` +
        `  project: <slug>\n  spaces:\n    - <space-name>`,
    );
  if (marker.spaces.length === 0)
    throw new CliError(`${marker.dir}/.memfed.yaml lists no spaces — add a 'spaces:' list`);
  return marker;
}

function registerProject(ctx: Ctx, marker: ResolvedProject, claudeMd?: boolean): void {
  ctx.config.projects[marker.slug] = {
    dir: marker.dir,
    spaces: marker.spaces,
    ...(claudeMd ? { claudeMd: true } : {}),
  };
  saveConfig(ctx.config, ctx.paths);
}

function mergeMcpJson(file: string, spec: { command: string; args: string[] }): void {
  let obj: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    try {
      obj = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new CliError(`${file} is not valid JSON: ${(e as Error).message}`);
    }
  }
  obj.mcpServers = { ...obj.mcpServers, memfed: spec };
  writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

/**
 * Project-scoped Claude Code SessionStart hook: stdout of the command is added
 * to session context, so the collision brief becomes ambient (RFC §12 stretch).
 */
function writeSessionStartHook(
  projectDir: string,
  spec: { command: string; args: string[] },
): string {
  const settingsDir = join(projectDir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const file = join(settingsDir, "settings.json");
  let settings: {
    hooks?: Record<
      string,
      Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
    >;
  } = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new CliError(`${file} is not valid JSON: ${(e as Error).message}`);
    }
  }
  const briefArgs = [...spec.args.slice(0, -1), "brief"]; // same launcher, 'brief' verb
  const command = [spec.command, ...briefArgs]
    .map((p) => (p.includes(" ") ? `"${p}"` : p))
    .join(" ");
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  const already = settings.hooks.SessionStart.some((entry) =>
    entry.hooks?.some((h) => h.command?.includes("brief")),
  );
  if (!already)
    settings.hooks.SessionStart.push({
      matcher: "startup|resume|clear",
      hooks: [{ type: "command", command }],
    });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

function doRender(
  ctx: Ctx,
  marker: ResolvedProject,
  opts: { claudeMd?: boolean; force?: boolean },
) {
  const results = renderProject(ctx.index, marker.dir, marker.slug, marker.spaces, opts);
  for (const r of results)
    console.log(
      `${pc.green(r.action.padEnd(9))} ${r.file}${r.action === "unchanged" ? pc.dim(" (up to date)") : ""}`,
    );
}

export function registerConnectCommands(program: Command): void {
  const connect = program
    .command("connect")
    .description("register the memfed MCP server + projections with an assistant");

  connect
    .command("claude")
    .description("Claude Code: project .mcp.json + AGENTS.md managed block")
    .option("--project <dir>", "project directory", ".")
    .option("--claude-md", "also render a managed block into CLAUDE.md")
    .option("--hook", "add a SessionStart hook that injects 'memfed brief' as context")
    .action(async (opts) => {
      await withCtx((ctx) => {
        const marker = requireMarker(resolve(opts.project));
        const spec = mcpServerSpec();
        mergeMcpJson(join(marker.dir, ".mcp.json"), spec);
        console.log(
          `${pc.green("wrote")}     ${join(marker.dir, ".mcp.json")} ${pc.dim(`(${spec.command} ${spec.args.join(" ")})`)}`,
        );
        registerProject(ctx, marker, opts.claudeMd);
        doRender(ctx, marker, { claudeMd: opts.claudeMd });
        if (opts.hook) {
          const file = writeSessionStartHook(marker.dir, spec);
          console.log(
            `${pc.green("wrote")}     ${file} ${pc.dim("(SessionStart hook: brief injected at session start)")}`,
          );
        }
        console.log(
          pc.dim("Claude Code will prompt to trust the project MCP server on next start."),
        );
      });
    });

  connect
    .command("codex")
    .description("Codex CLI: global 'codex mcp add' + AGENTS.md managed block")
    .option("--project <dir>", "project directory", ".")
    .action(async (opts) => {
      await withCtx((ctx) => {
        const marker = requireMarker(resolve(opts.project));
        const spec = mcpServerSpec();
        try {
          execFileSync("codex", ["mcp", "add", "memfed", "--", spec.command, ...spec.args], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          console.log(
            `${pc.green("registered")} memfed with codex ${pc.dim("(codex mcp add — global config)")}`,
          );
        } catch (e) {
          console.error(
            pc.yellow(
              `codex mcp add failed (${(e as Error).message.split("\n")[0]}); add this to ~/.codex/config.toml:\n` +
                `[mcp_servers.memfed]\ncommand = "${spec.command}"\nargs = [${spec.args.map((a) => `"${a}"`).join(", ")}]`,
            ),
          );
        }
        registerProject(ctx, marker);
        doRender(ctx, marker, {});
      });
    });

  connect
    .command("crush")
    .description("Crush (EXPERIMENTAL): project crush.json mcp entry + AGENTS.md managed block")
    .option("--project <dir>", "project directory", ".")
    .action(async (opts) => {
      await withCtx((ctx) => {
        const marker = requireMarker(resolve(opts.project));
        const spec = mcpServerSpec();
        const file = join(marker.dir, "crush.json");
        let obj: { mcp?: Record<string, unknown> } = {};
        if (existsSync(file)) {
          try {
            obj = JSON.parse(readFileSync(file, "utf8"));
          } catch (e) {
            throw new CliError(`${file} is not valid JSON: ${(e as Error).message}`);
          }
        }
        obj.mcp = {
          ...obj.mcp,
          memfed: { type: "stdio", command: spec.command, args: spec.args },
        };
        writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
        console.log(
          `${pc.green("wrote")}     ${file} ${pc.yellow("(experimental — Crush is not installed on this machine; stanza is spec-based, verify against Crush docs)")}`,
        );
        registerProject(ctx, marker);
        doRender(ctx, marker, {});
      });
    });

  connect
    .command("cursor")
    .description("Cursor: project .cursor/mcp.json + AGENTS.md managed block")
    .option("--project <dir>", "project directory", ".")
    .action(async (opts) => {
      await withCtx((ctx) => {
        const marker = requireMarker(resolve(opts.project));
        const dir = join(marker.dir, ".cursor");
        mkdirSync(dir, { recursive: true });
        mergeMcpJson(join(dir, "mcp.json"), mcpServerSpec());
        console.log(`${pc.green("wrote")}     ${join(dir, "mcp.json")}`);
        registerProject(ctx, marker);
        doRender(ctx, marker, {});
      });
    });

  program
    .command("render")
    .description("regenerate the managed AGENTS.md/CLAUDE.md block from synced records")
    .option("--project <dir>", "project directory", ".")
    .option("--claude-md", "also render into CLAUDE.md")
    .option("--check", "exit 1 if the block is out of date (CI mode); writes nothing")
    .option("--force", "regenerate over a hand-edited block")
    .action(async (opts) => {
      await withCtx((ctx) => {
        const marker = requireMarker(resolve(opts.project));
        const claudeMd = opts.claudeMd || ctx.config.projects[marker.slug]?.claudeMd;
        const results = renderProject(ctx.index, marker.dir, marker.slug, marker.spaces, {
          claudeMd,
          force: opts.force,
          check: opts.check,
        });
        let stale = false;
        for (const r of results) {
          const label = opts.check && r.action !== "unchanged" ? "stale" : r.action;
          console.log(`${(label === "stale" ? pc.yellow : pc.green)(label.padEnd(9))} ${r.file}`);
          if (r.action !== "unchanged") stale = true;
        }
        if (opts.check && stale) process.exitCode = 1;
      });
    });
}
