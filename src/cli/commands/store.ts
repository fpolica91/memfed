import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import pc from "picocolors";
import { appendAudit } from "../../core/audit.js";
import { ensureInit, getPaths, quarantineSet } from "../../core/config.js";
import { IndexDb, LOCAL_SOURCE } from "../../core/index-db.js";
import { findProjectMarker } from "../../core/project.js";
import { parseRecord } from "../../core/record.js";
import { nowIso, RECORD_STATUSES, RECORD_TYPES, type RecordType } from "../../core/types.js";
import { CliError, type Ctx, formatRow, openCtx, parseCsv, readStdin, resolveId } from "../util.js";

async function withCtx<T>(fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
  const ctx = await openCtx();
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

function resolveProjectSlug(ctx: Ctx, flag?: string): string {
  if (flag) return flag;
  const marker = findProjectMarker(process.cwd());
  if (marker) return marker.slug;
  throw new CliError(
    "no project: pass --project <slug> or add a .memfed.yaml ('project: <slug>') to the repo root",
  );
}

async function resolveBody(opts: { body?: string; bodyFile?: string }): Promise<string> {
  if (opts.body) return opts.body;
  if (opts.bodyFile === "-") return readStdin();
  if (opts.bodyFile) return readFileSync(opts.bodyFile, "utf8");
  if (!process.stdin.isTTY) return readStdin();
  throw new CliError("no body: pass --body, --body-file <path|->, or pipe on stdin");
}

export function registerStoreCommands(program: Command): void {
  program
    .command("init")
    .description("create the private store, index, and config under ~/.memfed (or $MEMFED_HOME)")
    .action(async () => {
      const paths = ensureInit(getPaths());
      const index = await IndexDb.open(paths.indexPath);
      index.close();
      appendAudit({ action: "init" }, paths.auditPath);
      console.log(`initialized memfed at ${pc.bold(paths.home)}`);
      console.log(pc.dim("next: memfed add --project <slug> --title '…' --body '…'"));
    });

  program
    .command("add")
    .description("capture a private record (nothing leaves this machine)")
    .option("-p, --project <slug>", "project slug (default: .memfed.yaml discovery)")
    .option("-t, --type <type>", `record type: ${RECORD_TYPES.join("|")}`, "reference")
    .option("--title <title>", "record title (default: first line of body)")
    .option("--tags <a,b>", "comma-separated topic tags")
    .option("--paths <globs>", "comma-separated repo-relative path globs")
    .option("--body <text>", "record body")
    .option("--body-file <file>", "read body from file ('-' = stdin)")
    .option("--tool <tool>", "capturing tool for provenance", "manual")
    .action(async (opts) => {
      await withCtx(async (ctx) => {
        if (!(RECORD_TYPES as readonly string[]).includes(opts.type))
          throw new CliError(`invalid type '${opts.type}' (expected ${RECORD_TYPES.join("|")})`);
        const body = (await resolveBody(opts)).trim();
        const project = resolveProjectSlug(ctx, opts.project);
        const { record, dirty } = ctx.store.create({
          title: opts.title,
          type: opts.type as RecordType,
          project,
          body,
          tags: parseCsv(opts.tags),
          paths: parseCsv(opts.paths),
          tool: opts.tool,
        });
        console.log(`${pc.green("created")} ${record.fm.id} ${pc.dim("(private)")}`);
        if (dirty)
          console.log(
            pc.yellow(
              "note: body contains redaction findings — this record will never be suggested for sharing until cleaned",
            ),
          );
      });
    });

  program
    .command("list")
    .description("list records (private + synced spaces)")
    .option("-p, --project <slug>")
    .option("-t, --type <type>")
    .option("--status <status>", `one of ${RECORD_STATUSES.join("|")}`)
    .option("--space <name>", "filter by source: a space name or 'local'")
    .option("-n, --limit <n>", "max rows", "50")
    .action(async (opts) => {
      await withCtx((ctx) => {
        const quarantined = quarantineSet(ctx.paths);
        const rows = ctx.index
          .search({
            project: opts.project,
            type: opts.type,
            status: opts.status,
            space: opts.space,
            limit: Number(opts.limit),
          })
          .filter((r) => !quarantined.has(r.id));
        if (rows.length === 0) {
          console.log(pc.dim("no records"));
          return;
        }
        for (const r of rows) console.log(formatRow(r));
      });
    });

  program
    .command("show <id>")
    .description("print a record (id may be a unique prefix)")
    .option("--json", "print indexed metadata as JSON")
    .action(async (idArg, opts) => {
      await withCtx((ctx) => {
        const id = resolveId(ctx, idArg);
        const row = ctx.index.getById(id);
        if (!row) throw new CliError(`record ${id} not in index — try 'memfed reindex'`);
        if (opts.json) {
          console.log(JSON.stringify(row, null, 2));
          return;
        }
        const sources = ctx.index.sourcesForId(id).map((s) => (s === LOCAL_SOURCE ? "private" : s));
        console.log(pc.dim(`# source: ${sources.join(", ")}`));
        console.log(readFileSync(row.file_path, "utf8"));
      });
    });

  program
    .command("search <query...>")
    .description("full-text search across private store and synced spaces")
    .option("-p, --project <slug>")
    .option("-t, --type <type>")
    .option("--space <name>", "a space name or 'local'")
    .option("-n, --limit <n>", "max results", "20")
    .action(async (queryParts: string[], opts) => {
      await withCtx((ctx) => {
        const quarantined = quarantineSet(ctx.paths);
        const rows = ctx.index
          .search({
            query: queryParts.join(" "),
            project: opts.project,
            type: opts.type,
            space: opts.space,
            limit: Number(opts.limit),
          })
          .filter((r) => !quarantined.has(r.id));
        if (rows.length === 0) {
          console.log(pc.dim("no matches"));
          return;
        }
        for (const r of rows) console.log(formatRow(r));
      });
    });

  program
    .command("edit <id>")
    .description("edit a private record (published bodies are immutable — use supersede)")
    .option("--title <title>")
    .option("--type <type>")
    .option("--tags <a,b>")
    .option("--paths <globs>")
    .option("--body-file <file>", "replace body from file ('-' = stdin)")
    .action(async (idArg, opts) => {
      await withCtx(async (ctx) => {
        const id = resolveId(ctx, idArg);
        if (!ctx.store.exists(id))
          throw new CliError(
            `record ${id} is not in the private store (space records are edited via supersede/retract)`,
          );
        const bodyChange = opts.bodyFile !== undefined;
        const titleChange = opts.title !== undefined;
        if (ctx.store.isPublished(id) && (bodyChange || titleChange))
          throw new CliError(
            `record ${id} is published — bodies/titles of published records are immutable; use 'memfed supersede'`,
          );
        const record = ctx.store.get(id);
        if (opts.title) record.fm.title = opts.title;
        if (opts.type) {
          if (!(RECORD_TYPES as readonly string[]).includes(opts.type))
            throw new CliError(`invalid type '${opts.type}'`);
          record.fm.type = opts.type as RecordType;
        }
        if (opts.tags) record.fm.tags = parseCsv(opts.tags);
        if (opts.paths) record.fm.paths = parseCsv(opts.paths);
        if (bodyChange)
          record.body =
            opts.bodyFile === "-" ? await readStdin() : readFileSync(opts.bodyFile, "utf8");

        if (!bodyChange && !titleChange && !opts.tags && !opts.paths && !opts.type) {
          // Interactive: open $EDITOR on the file itself.
          if (!process.stdout.isTTY) throw new CliError("no edit flags given and not a TTY");
          const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
          execFileSync(editor, [ctx.store.recordPath(id)], { stdio: "inherit" });
          const reparsed = parseRecord(readFileSync(ctx.store.recordPath(id), "utf8"));
          ctx.store.write(reparsed);
          console.log(`${pc.green("updated")} ${id}`);
          return;
        }
        record.fm.updated = nowIso();
        ctx.store.write(record);
        console.log(`${pc.green("updated")} ${id}`);
      });
    });

  program
    .command("reindex")
    .description("rebuild the search index from record files (files are the truth)")
    .option("--full", "also clear and rebuild space sources")
    .action(async (opts) => {
      await withCtx(async (ctx) => {
        const { count, errors } = ctx.store.reindexLocal();
        console.log(`reindexed ${count} private record(s)`);
        for (const e of errors) console.error(pc.red(`  skip ${e.file}: ${e.error}`));
        if (opts.full) {
          const { reindexSpace } = await import("../../git/space.js");
          const { ensureSpaceClone } = await import("./sync.js");
          for (const name of Object.keys(ctx.config.spaces)) {
            try {
              const space = ensureSpaceClone(ctx, name);
              const r = reindexSpace(ctx.index, space);
              console.log(`reindexed ${r.count} record(s) from space '${name}'`);
              errors.push(...r.errors);
            } catch (e) {
              console.error(pc.red(`  space ${name}: ${(e as Error).message}`));
            }
          }
        }
        if (errors.length > 0) process.exitCode = 1;
      });
    });
}
