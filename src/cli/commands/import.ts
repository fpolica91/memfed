import type { Command } from "commander";
import pc from "picocolors";
import { saveConfig } from "../../core/config.js";
import { importClaudeMem } from "../../importers/claude-mem.js";
import { importClaudeNative } from "../../importers/claude-native.js";
import { CliError, type Ctx, openCtx, parseCsv } from "../util.js";

async function withCtx<T>(fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
  const ctx = await openCtx();
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

function parseMaps(values: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of values) {
    const [from, to] = v.split("=");
    if (!from || !to) throw new CliError(`--map expects old=new, got '${v}'`);
    map[from] = to;
  }
  return map;
}

function report(
  what: string,
  r: { imported: number; skippedDuplicates: number; skippedInvalid: number; total: number },
): void {
  console.log(
    `${pc.green("imported")} ${r.imported}/${r.total} ${what} record(s) as private candidates` +
      pc.dim(` (${r.skippedDuplicates} duplicate(s), ${r.skippedInvalid} invalid skipped)`),
  );
  if (r.imported > 0)
    console.log(
      pc.dim(
        "triage them with 'memfed list --status candidate' and 'memfed review' after proposing",
      ),
    );
}

export function registerImportCommands(program: Command): void {
  const imp = program
    .command("import")
    .description("import existing memory as PRIVATE candidates (importing never publishes)");

  imp
    .command("claude-mem")
    .description("import from claude-mem's SQLite (read-only; source is never modified)")
    .option("--db <path>", "database path (default ~/.claude-mem/claude-mem.db)")
    .option("--types <a,b|all>", "observation types (default: decision)", "decision")
    .option(
      "--map <old=new>",
      "rename a claude-mem cwd-basename project to a slug (repeatable, persisted)",
      (v: string, acc: string[]) => acc.concat(v),
      [] as string[],
    )
    .option("--limit <n>", "max observations to read")
    .action(async (opts) => {
      await withCtx(async (ctx) => {
        const map = { ...(ctx.config.importMaps?.claudeMem ?? {}), ...parseMaps(opts.map) };
        if (opts.map.length > 0) {
          ctx.config.importMaps = { ...ctx.config.importMaps, claudeMem: map };
          saveConfig(ctx.config, ctx.paths);
        }
        const result = await importClaudeMem(ctx.store, {
          dbPath: opts.db,
          types: parseCsv(opts.types),
          map,
          limit: opts.limit ? Number(opts.limit) : undefined,
        });
        report("claude-mem", result);
      });
    });

  imp
    .command("claude-native")
    .description("import Claude Code's native per-project memory files")
    .option("--dir <path>", "projects dir (default ~/.claude/projects)")
    .option(
      "--map <old=new>",
      "rename a project-dir slug (repeatable)",
      (v: string, acc: string[]) => acc.concat(v),
      [] as string[],
    )
    .action(async (opts) => {
      await withCtx((ctx) => {
        const result = importClaudeNative(ctx.store, {
          dir: opts.dir,
          map: parseMaps(opts.map),
        });
        report("claude-native", result);
      });
    });
}
