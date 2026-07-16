import type { Command } from "commander";
import pc from "picocolors";
import { appendAudit } from "../../core/audit.js";
import { loadState, quarantineSet } from "../../core/config.js";
import { newId } from "../../core/ids.js";
import { LOCAL_SOURCE } from "../../core/index-db.js";
import { nowIso, type RecordType, SHAREABLE_TYPES } from "../../core/types.js";
import { aheadCount } from "../../git/exec.js";
import { loadSpace } from "../../git/space.js";
import { type Ctx, formatRow, openCtx } from "../util.js";

async function withCtx<T>(fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
  const ctx = await openCtx();
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

/** Personal-context veto (RFC §7.3): home paths and first-person scratch stay private. */
const PERSONAL_CONTEXT_RE = /(?:^|[\s"'`(])~\/|\/home\/|\/Users\//;

export function registerInsightCommands(program: Command): void {
  program
    .command("suggest")
    .description("deterministic share candidates from your private store (RFC §7.3)")
    .option("--project <slug>")
    .option("--propose", "stage every suggestion for review (nothing is published)")
    .option("--to <space>", "destination for --propose (default: the project's first space)")
    .action(async (opts) => {
      await withCtx((ctx) => {
        const openProposals = new Set(ctx.index.listProposals("proposed").map((p) => p.record_id));
        const suggestions = ctx.index
          .search({ space: LOCAL_SOURCE, status: "active", project: opts.project, limit: 1000 })
          .filter(
            (r) =>
              SHAREABLE_TYPES.includes(r.type as RecordType) &&
              !r.redaction_dirty &&
              !openProposals.has(r.id) &&
              ctx.index.sourcesForId(r.id).every((s) => s === LOCAL_SOURCE) &&
              !PERSONAL_CONTEXT_RE.test(r.body),
          );
        if (suggestions.length === 0) {
          console.log(
            pc.dim("no share candidates — capture more, or everything is already shared"),
          );
          return;
        }
        if (opts.to) loadSpace(ctx.paths, ctx.config, opts.to); // validate early
        const destinationFor = (project: string): string | undefined =>
          opts.to ??
          ctx.config.projects[project]?.spaces[0] ??
          (Object.keys(ctx.config.spaces).length === 1
            ? Object.keys(ctx.config.spaces)[0]
            : undefined);

        let staged = 0;
        for (const r of suggestions) {
          const dest = destinationFor(r.project);
          console.log(
            `${formatRow(r)}${dest ? pc.dim(`  → suggest: ${dest}`) : pc.dim("  → no destination (join/create a space or connect the project)")}`,
          );
          if (opts.propose && dest) {
            const now = nowIso();
            ctx.index.insertProposal({
              id: newId(),
              record_id: r.id,
              space: dest,
              state: "proposed",
              origin: "cli",
              created: now,
              updated: now,
            });
            appendAudit(
              { action: "propose", record_id: r.id, space: dest, origin: "cli" },
              ctx.paths.auditPath,
            );
            staged++;
          }
        }
        console.log(
          opts.propose
            ? pc.dim(
                `\nstaged ${staged} proposal(s) — review with 'memfed review' (nothing was published)`,
              )
            : pc.dim(`\nstage them with 'memfed suggest --propose', then 'memfed review'`),
        );
      });
    });

  program
    .command("status")
    .description("store, proposals, spaces, and promotion drift at a glance (RFC §6.4)")
    .action(async () => {
      await withCtx((ctx) => {
        const stats = ctx.index.localStats();
        const quarantined = quarantineSet(ctx.paths).size;
        console.log(
          `${pc.bold("private store")}   ${stats.total} record(s), ${stats.candidates} candidate(s), ${stats.dirty} redaction-dirty${quarantined ? `, ${quarantined} quarantined` : ""}`,
        );

        const open = ctx.index.listProposals("proposed");
        if (open.length > 0) {
          const bySpace = new Map<string, number>();
          for (const p of open) bySpace.set(p.space, (bySpace.get(p.space) ?? 0) + 1);
          console.log(
            `${pc.bold("share queue")}     ${open.length} proposal(s): ${[...bySpace.entries()]
              .map(([s, n]) => `${s}=${n}`)
              .join(", ")}  ${pc.dim("(memfed review)")}`,
          );
        }

        const state = loadState(ctx.paths);
        for (const name of Object.keys(ctx.config.spaces)) {
          try {
            const space = loadSpace(ctx.paths, ctx.config, name);
            const n = ctx.index.idsForSource(name).length;
            const ahead = aheadCount(space.dir, "origin/main");
            const presence = state.presence[name]?.mode ?? "off";
            console.log(
              `${pc.bold(`space ${name}`)}${" ".repeat(Math.max(1, 10 - name.length))}${n} record(s), ${space.manifest.kind}/${space.manifest.publish}${ahead ? pc.yellow(`, ${ahead} unpushed commit(s) — run sync`) : ""}${presence !== "off" ? pc.dim(`, presence ${presence}`) : ""}`,
            );
          } catch (e) {
            console.log(`${pc.bold(`space ${name}`)} ${pc.red((e as Error).message)}`);
          }
        }

        // Promotion drift: same ULID, diverged copies across spaces (RFC §6.4).
        let drift = 0;
        for (const { id, sources } of ctx.index.crossSpaceRecords()) {
          const rows = sources
            .map((s) => ctx.index.getById(id, s))
            .filter((r): r is NonNullable<typeof r> => Boolean(r));
          const statuses = new Set(rows.map((r) => r.status));
          const hashes = new Set(rows.map((r) => r.content_hash));
          if (statuses.size > 1 || hashes.size > 1) {
            drift++;
            console.log(
              `${pc.yellow("drift")}          ${id.slice(0, 10)} ${rows[0]?.title ?? ""} — ${rows
                .map((r) => `${r.source}:${r.status}${hashes.size > 1 ? "*" : ""}`)
                .join("  ")}${hashes.size > 1 ? pc.dim("  (*bodies differ)") : ""}`,
            );
          }
        }
        if (drift > 0)
          console.log(
            pc.dim(
              "drifted copies are independent per space — align with supersede/retract/promote",
            ),
          );
      });
    });
}
