import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { appendAudit } from "../../core/audit.js";
import { loadState, resolveAuthor, saveState } from "../../core/config.js";
import { parseRecord, serializeRecord } from "../../core/record.js";
import { nowIso } from "../../core/types.js";
import { git, pushMainWithRetry } from "../../git/exec.js";
import { pushProposalBranch } from "../../git/proposals.js";
import { commitAndPush, runRedactionGate } from "../../git/publish.js";
import { contentDir, loadSpace, recordRelPath, type Space } from "../../git/space.js";
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
  const file = join(contentDir(space), "records", `${id}.md`);
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
        git(["add", recordRelPath(space, id)], { cwd: space.dir });
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
        const newFile = join(contentDir(space), "records", `${newId_}.md`);
        writeFileSync(newFile, serializeRecord(replacement));

        // Old record: metadata-only backlink commit (RFC §7.6).
        const { file: oldFile, record: old } = readSpaceRecord(space, oldId);
        old.fm.status = "superseded";
        old.fm.superseded_by = newId_;
        old.fm.updated = nowIso();
        writeFileSync(oldFile, serializeRecord(old));

        git(["add", recordRelPath(space, oldId), recordRelPath(space, newId_)], { cwd: space.dir });
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
    .command("promote <id>")
    .description("re-publish an already-published record to a broader space (project → org)")
    .requiredOption("--to <space>", "destination (usually an org space)")
    .option("--from <space>", "source space (default: first space containing the record)")
    .action(async (idArg, opts) => {
      await withCtx((ctx) => {
        const id = resolveId(ctx, idArg);
        const sources = ctx.index.sourcesForId(id).filter((s) => s !== "local");
        if (sources.length === 0)
          throw new CliError(
            `record ${id} is not published anywhere — promotion re-publishes published records; use 'memfed share' for private ones`,
          );
        if (ctx.index.getById(id, opts.to))
          throw new CliError(`record ${id} is already published in '${opts.to}'`);
        const candidates = sources.filter((s) => s !== opts.to);
        const fromName = opts.from ?? candidates[0];
        if (!fromName || !candidates.includes(fromName))
          throw new CliError(
            `record ${id} has no promotable source${opts.from ? ` '${opts.from}'` : ""} (published in: ${sources.join(", ")})`,
          );

        const source = loadSpace(ctx.paths, ctx.config, fromName);
        const dest = loadSpace(ctx.paths, ctx.config, opts.to);
        // Canonical copy comes from the SOURCE SPACE, not the private store —
        // non-authors may promote (publication already disclosed the content).
        const { record } = readSpaceRecord(source, id);
        if (record.fm.status !== "active")
          throw new CliError(`refusing to promote a '${record.fm.status}' record (RFC §7.4)`);

        record.fm.promoted_from = `${fromName}/${id}`;
        record.fm.promoted_by = resolveAuthor(ctx.config);
        record.fm.updated = nowIso();

        // The audience changed, so the FULL pipeline re-runs (gate + destination policy).
        runRedactionGate(ctx, record, dest);
        if (dest.manifest.publish === "pr") {
          const commit = pushProposalBranch(ctx, record, dest);
          appendAudit(
            {
              action: "promote",
              record_id: id,
              space: dest.name,
              commit,
              details: { from: fromName, via: "proposal" },
            },
            ctx.paths.auditPath,
          );
          console.log(
            `${pc.green("promotion proposed")} ${id} ${fromName} → '${dest.name}' ${pc.dim(`(a maintainer approves with 'memfed approve ${id.slice(0, 10)} --space ${dest.name}')`)}`,
          );
          return;
        }
        const outcome = commitAndPush(ctx, record, dest);
        appendAudit(
          {
            action: "promote",
            record_id: id,
            space: dest.name,
            commit: outcome.commit,
            details: { from: fromName },
          },
          ctx.paths.auditPath,
        );
        console.log(
          `${pc.green("promoted")} ${id} ${fromName} → '${dest.name}' ${pc.dim(`@${outcome.commit.slice(0, 8)}`)}`,
        );
      });
    });

  program
    .command("gardening")
    .description("list published records overdue for review (review_after in the past)")
    .option("--space <name>")
    .action(async (opts) => {
      await withCtx((ctx) => {
        const today = new Date().toISOString().slice(0, 10);
        const spaces = opts.space
          ? [opts.space]
          : ctx.index.listSources().filter((s) => s !== "local");
        let found = 0;
        for (const space of spaces) {
          const overdue = ctx.index
            .search({ space, status: "active", limit: 500 })
            .filter((r) => r.review_after && r.review_after < today);
          for (const r of overdue) {
            found++;
            console.log(
              `${r.id.slice(0, 10)}  [${r.type}] ${r.title}  ${pc.yellow(`review overdue since ${r.review_after}`)}  ${pc.dim(`(${space})`)}`,
            );
          }
        }
        if (found === 0) console.log(pc.dim("nothing overdue — the garden is tidy"));
        else console.log(pc.dim("\nre-confirm with a metadata edit, supersede, or retract"));
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
