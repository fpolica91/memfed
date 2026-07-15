import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { appendAudit } from "../../core/audit.js";
import { loadState, saveState } from "../../core/config.js";
import { LOCAL_SOURCE } from "../../core/index-db.js";
import { parseRecord, serializeRecord } from "../../core/record.js";
import { nowIso } from "../../core/types.js";
import { git, pushMainWithRetry } from "../../git/exec.js";
import { runRedactionGate } from "../../git/publish.js";
import { loadSpace, type Space } from "../../git/space.js";
import { CliError, type Ctx, openCtx, resolveId } from "../util.js";

async function withCtx<T>(fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
  const ctx = await openCtx();
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

function readSpaceRecord(space: Space, id: string) {
  const file = join(space.dir, "records", `${id}.md`);
  return { file, record: parseRecord(readFileSync(file, "utf8"), file) };
}

export function registerLifecycleCommands(program: Command): void {
  program
    .command("retract <id>")
    .description(
      "retract a published record: tombstone stub, excluded everywhere (git history persists)",
    )
    .requiredOption("--space <name>")
    .requiredOption("--reason <text>")
    .action(async (idArg, opts) => {
      await withCtx((ctx) => {
        const id = resolveId(ctx, idArg);
        const space = loadSpace(ctx.paths, ctx.config, opts.space);
        git(["fetch", "-q", "origin"], { cwd: space.dir });
        git(["merge", "--ff-only", "-q", "origin/main"], { cwd: space.dir, check: false });
        const { file, record } = readSpaceRecord(space, id);

        record.fm.status = "retracted";
        record.fm.updated = nowIso();
        record.body =
          `RETRACTED (${nowIso().slice(0, 10)}): ${opts.reason}\n\n` +
          `The original body was removed from the tip of this space. Git history preserves\n` +
          `it — if this retraction removes a leaked credential, ROTATE THE CREDENTIAL.`;
        writeFileSync(file, serializeRecord(record));
        git(["add", `records/${id}.md`], { cwd: space.dir });
        git(["commit", "-q", "-m", `memfed: retract ${id.slice(0, 10)}`], { cwd: space.dir });
        pushMainWithRetry(space.dir, `retraction of ${id}`);
        ctx.index.upsertRecord(space.name, record, file);
        appendAudit(
          { action: "retract", record_id: id, space: space.name, reason: opts.reason },
          ctx.paths.auditPath,
        );
        console.log(`${pc.green("retracted")} ${id} from '${space.name}'`);
        console.log(
          pc.yellow(
            "note: retraction removes the record from the space tip, NOT from git history.\n" +
              "If this removed a leaked secret, rotate it now.",
          ),
        );
      });
    });

  program
    .command("supersede <old>")
    .description("publish a correction: new record supersedes the old one (bodies are immutable)")
    .requiredOption("--with <newId>", "the private record that replaces it")
    .requiredOption("--space <name>")
    .action(async (oldArg, opts) => {
      await withCtx((ctx) => {
        const oldId = resolveId(ctx, oldArg);
        const newId_ = resolveId(ctx, opts.with);
        const space = loadSpace(ctx.paths, ctx.config, opts.space);
        if (!ctx.store.exists(newId_))
          throw new CliError(`replacement ${newId_} must be a private record you own`);
        if (!ctx.index.getById(oldId, space.name))
          throw new CliError(`record ${oldId} is not published in '${space.name}'`);

        git(["fetch", "-q", "origin"], { cwd: space.dir });
        git(["merge", "--ff-only", "-q", "origin/main"], { cwd: space.dir, check: false });

        // New record: publishes with supersedes link; full gate applies.
        const replacement = ctx.store.get(newId_);
        replacement.fm.supersedes = oldId;
        runRedactionGate(ctx, replacement, space);
        const newFile = join(space.dir, "records", `${newId_}.md`);
        writeFileSync(newFile, serializeRecord(replacement));

        // Old record: metadata-only backlink commit (RFC §7.6).
        const { file: oldFile, record: old } = readSpaceRecord(space, oldId);
        old.fm.status = "superseded";
        old.fm.superseded_by = newId_;
        old.fm.updated = nowIso();
        writeFileSync(oldFile, serializeRecord(old));

        git(["add", `records/${oldId}.md`, `records/${newId_}.md`], { cwd: space.dir });
        git(
          [
            "commit",
            "-q",
            "-m",
            `memfed: supersede ${oldId.slice(0, 10)} → ${newId_.slice(0, 10)}`,
          ],
          { cwd: space.dir },
        );
        pushMainWithRetry(space.dir, `supersede of ${oldId}`);

        ctx.index.upsertRecord(space.name, replacement, newFile);
        ctx.index.upsertRecord(space.name, old, oldFile);
        // Keep the private replacement's link in sync too.
        ctx.store.write(replacement, { audit: false });
        appendAudit(
          {
            action: "supersede",
            record_id: oldId,
            space: space.name,
            details: { superseded_by: newId_ },
          },
          ctx.paths.auditPath,
        );
        console.log(`${pc.green("superseded")} ${oldId} → ${newId_} in '${space.name}'`);
      });
    });

  program
    .command("quarantine <id>")
    .description("local kill-switch: exclude a record from your briefs/projections/search (T2)")
    .option("--undo", "remove the record from quarantine")
    .action(async (idArg, opts) => {
      await withCtx((ctx) => {
        const id = resolveId(ctx, idArg);
        const state = loadState(ctx.paths);
        const set = new Set(state.quarantined ?? []);
        if (opts.undo) set.delete(id);
        else set.add(id);
        state.quarantined = [...set];
        saveState(state, ctx.paths);
        appendAudit(
          { action: "quarantine", record_id: id, details: { undo: Boolean(opts.undo) } },
          ctx.paths.auditPath,
        );
        console.log(
          opts.undo
            ? `${pc.green("unquarantined")} ${id}`
            : `${pc.green("quarantined")} ${id} ${pc.dim("(local only — excluded from your briefs/projections/search; space copy untouched)")}`,
        );
        // Projections refresh on next sync/render; nudge:
        console.log(pc.dim("run 'memfed render' in affected projects to refresh projections"));
      });
    });
}
