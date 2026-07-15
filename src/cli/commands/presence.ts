import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import pc from "picocolors";
import { appendAudit } from "../../core/audit.js";
import { loadState, resolveAuthor, saveState } from "../../core/config.js";
import {
  DEFAULT_TTL_HOURS,
  hourRoundedNow,
  MAX_NOTE_LEN,
  MAX_TTL_HOURS,
  type PresenceEntry,
  readPresence,
  writePresence,
} from "../../git/presence.js";
import { loadSpace } from "../../git/space.js";
import { ago, CliError, type Ctx, openCtx, parseCsv } from "../util.js";

async function withCtx<T>(fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
  const ctx = await openCtx();
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

function gitUserName(): string {
  try {
    return execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function buildEntry(
  ctx: Ctx,
  opts: {
    note: string;
    areas?: string[];
    project?: string;
    ttlHours?: number;
  },
): PresenceEntry {
  if (opts.note.length > MAX_NOTE_LEN)
    throw new CliError(`note exceeds ${MAX_NOTE_LEN} chars (the schema is the consent boundary)`);
  const ttl = opts.ttlHours ?? DEFAULT_TTL_HOURS;
  if (ttl > MAX_TTL_HOURS) throw new CliError(`ttl-hours max is ${MAX_TTL_HOURS}`);
  for (const area of opts.areas ?? [])
    if (area.includes("/"))
      throw new CliError(`areas are coarse topic tags, never file paths (got '${area}')`);
  return {
    author: resolveAuthor(ctx.config),
    name: gitUserName(),
    project: opts.project,
    areas: opts.areas ?? [],
    note: opts.note,
    updated: hourRoundedNow(),
    ttl_hours: ttl,
  };
}

function pushEntry(ctx: Ctx, spaceName: string, entry: PresenceEntry, mode: "on" | "auto"): void {
  const space = loadSpace(ctx.paths, ctx.config, spaceName);
  if (space.manifest.presence === "off")
    throw new CliError(`space '${spaceName}' has presence disabled in its manifest`);
  writePresence(ctx.paths, space, entry);
  const state = loadState(ctx.paths);
  state.presence[spaceName] = {
    mode,
    lastPush: new Date().toISOString(),
    note: entry.note,
    areas: entry.areas,
    project: entry.project,
    ttlHours: entry.ttl_hours,
  };
  saveState(state, ctx.paths);
  appendAudit(
    {
      action: "presence",
      space: spaceName,
      details: { note: entry.note, areas: entry.areas, ttl: entry.ttl_hours },
    },
    ctx.paths.auditPath,
  );
}

export function registerPresenceCommands(program: Command): void {
  const presence = program
    .command("presence")
    .description("opt-in 'recent activity' signal — fixed schema, TTL'd, never live tracking");

  presence
    .command("set")
    .description("publish/refresh YOUR presence entry (implies consent for this space)")
    .requiredOption("--space <name>")
    .requiredOption("--note <text>", `what you're working on (user-typed, <=${MAX_NOTE_LEN} chars)`)
    .option("--areas <a,b>", "coarse topic tags (never file paths)")
    .option("--project <slug>")
    .option("--ttl-hours <n>", `expiry (default ${DEFAULT_TTL_HOURS}, max ${MAX_TTL_HOURS})`)
    .option("--auto", "also refresh automatically on 'memfed sync' (standing consent)")
    .action(async (opts) => {
      await withCtx((ctx) => {
        const entry = buildEntry(ctx, {
          note: opts.note,
          areas: parseCsv(opts.areas),
          project: opts.project,
          ttlHours: opts.ttlHours ? Number(opts.ttlHours) : undefined,
        });
        pushEntry(ctx, opts.space, entry, opts.auto ? "auto" : "on");
        console.log(
          `${pc.green("presence published")} to '${opts.space}' ${pc.dim(`(expires in ${entry.ttl_hours}h; hour-rounded timestamp)`)}`,
        );
        if (opts.auto)
          console.log(pc.dim("auto mode: 'memfed sync' refreshes the timestamp at most every 4h"));
      });
    });

  presence
    .command("off")
    .description("stop publishing presence for a space (existing entry expires by TTL)")
    .requiredOption("--space <name>")
    .action(async (opts) => {
      await withCtx((ctx) => {
        const state = loadState(ctx.paths);
        state.presence[opts.space] = { mode: "off" };
        saveState(state, ctx.paths);
        appendAudit(
          { action: "presence", space: opts.space, details: { mode: "off" } },
          ctx.paths.auditPath,
        );
        console.log(
          `${pc.green("presence off")} for '${opts.space}' ${pc.dim("(your current entry, if any, expires by its TTL)")}`,
        );
      });
    });

  presence
    .command("show")
    .description("show exactly what you publish, and teammates' unexpired entries")
    .option("--space <name>", "one space (default: all)")
    .action(async (opts) => {
      await withCtx((ctx) => {
        const self = resolveAuthor(ctx.config).toLowerCase();
        const names = opts.space ? [opts.space] : Object.keys(ctx.config.spaces);
        for (const name of names) {
          let entries: PresenceEntry[];
          try {
            entries = readPresence(loadSpace(ctx.paths, ctx.config, name));
          } catch (e) {
            console.log(`${pc.bold(name)}: ${pc.red((e as Error).message)}`);
            continue;
          }
          const mode = loadState(ctx.paths).presence[name]?.mode ?? "off";
          console.log(`${pc.bold(name)} ${pc.dim(`(your mode: ${mode})`)}`);
          if (entries.length === 0) {
            console.log(pc.dim("  no unexpired presence entries"));
            continue;
          }
          for (const e of entries) {
            const who = e.author.toLowerCase() === self ? pc.green(`${e.name} (you)`) : e.name;
            console.log(
              `  ${who}: "${e.note}" ${pc.dim(`— ${e.areas.join(", ") || "no areas"} · ${ago(e.updated)} · ttl ${e.ttl_hours}h${e.project ? ` · project ${e.project}` : ""}`)}`,
            );
          }
        }
      });
    });
}
