import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { appendAudit } from "../../core/audit.js";
import { newId } from "../../core/ids.js";
import { nowIso } from "../../core/types.js";
import { pushProposalBranch, tryCreateForgePr } from "../../git/proposals.js";
import { commitAndPush, runRedactionGate } from "../../git/publish.js";
import { loadSpace } from "../../git/space.js";
import { CliError, type Ctx, openCtx, resolveId } from "../util.js";

/** Typed false-positive overrides: allowlisted + audited, never silent (RFC §3). */
export function recordOverrides(
  ctx: Ctx,
  recordId: string,
  entries: string[],
  reason: string,
): void {
  const file = join(ctx.paths.home, "redaction-allow.json");
  const existing: Array<{ ruleId: string; fingerprint: string; reason?: string }> = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : [];
  for (const entry of entries) {
    const [ruleId, fingerprint] = entry.split(":");
    if (!ruleId || !fingerprint)
      throw new CliError(`--override expects <ruleId:fingerprint>, got '${entry}'`);
    if (!existing.some((e) => e.ruleId === ruleId && e.fingerprint === fingerprint))
      existing.push({ ruleId, fingerprint, reason });
    appendAudit(
      {
        action: "redaction-override",
        record_id: recordId,
        reason,
        findings: [{ ruleId, fingerprint, excerpt: "(allowlisted as false positive)" }],
      },
      ctx.paths.auditPath,
    );
  }
  writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
}

async function withCtx<T>(fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
  const ctx = await openCtx();
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

const KIND_READERSHIP: Record<string, string> = {
  project: "everyone with read access to this project's space repo",
  team: "everyone with read access to the team space repo",
  org: "EVERYONE in the org with read access to the org space repo",
};

export function registerShareCommands(program: Command): void {
  program
    .command("propose <id>")
    .description("stage a record for publication (nothing leaves the machine yet)")
    .requiredOption("--to <space>", "destination space")
    .action(async (idArg, opts) => {
      await withCtx((ctx) => {
        const id = resolveId(ctx, idArg);
        if (!ctx.store.exists(id)) throw new CliError(`record ${id} is not in the private store`);
        loadSpace(ctx.paths, ctx.config, opts.to); // validates destination exists
        if (ctx.index.findOpenProposal(id, opts.to)) {
          console.log(pc.dim(`already proposed to '${opts.to}'`));
          return;
        }
        const now = nowIso();
        ctx.index.insertProposal({
          id: newId(),
          record_id: id,
          space: opts.to,
          state: "proposed",
          origin: "cli",
          created: now,
          updated: now,
        });
        appendAudit(
          { action: "propose", record_id: id, space: opts.to, origin: "cli" },
          ctx.paths.auditPath,
        );
        console.log(
          `${pc.green("staged")} ${id} → '${opts.to}' ${pc.dim("(publish with: memfed share " + id.slice(0, 10) + " --to " + opts.to + ")")}`,
        );
      });
    });

  program
    .command("share <id>")
    .description("publish a private record to a space (redaction gate + consent ceremony)")
    .requiredOption("--to <space>", "destination space")
    .option("--yes", "skip the interactive confirmation (findings still block)")
    .option(
      "--override <ruleId:fingerprint>",
      "allowlist one redaction finding as a false positive (repeatable; requires --reason)",
      (v: string, acc: string[]) => acc.concat(v),
      [] as string[],
    )
    .option("--reason <text>", "reason for --override entries (audited)")
    .action(async (idArg, opts) => {
      await withCtx(async (ctx) => {
        const id = resolveId(ctx, idArg);
        if (!ctx.store.exists(id))
          throw new CliError(
            `record ${id} is not in the private store — only your own private records can be shared`,
          );
        const record = ctx.store.get(id);
        const space = loadSpace(ctx.paths, ctx.config, opts.to);

        if (opts.override.length > 0) {
          if (!opts.reason) throw new CliError("--override requires --reason <text> (audited)");
          recordOverrides(ctx, id, opts.override, opts.reason);
        }

        // The gate runs BEFORE the ceremony so the human sees exactly what ships (RFC §7.4).
        const scanResult = runRedactionGate(ctx, record, space);

        if (space.manifest.publish === "pr") {
          const commit = pushProposalBranch(ctx, record, space);
          const open = ctx.index.findOpenProposal(id, space.name);
          const now = nowIso();
          if (!open)
            ctx.index.insertProposal({
              id: newId(),
              record_id: id,
              space: space.name,
              state: "proposed",
              origin: "cli",
              created: now,
              updated: now,
            });
          appendAudit(
            { action: "propose", record_id: id, space: space.name, origin: "cli", commit },
            ctx.paths.auditPath,
          );
          console.log(
            `${pc.green("proposal pushed")} ${id} → '${space.name}' ${pc.dim(`(branch memfed/proposals/${id})`)}\n` +
              pc.dim(
                `this space requires review: a maintainer publishes it with 'memfed approve ${id.slice(0, 10)} --space ${space.name}'`,
              ),
          );
          const prUrl = tryCreateForgePr(space, record);
          if (prUrl) console.log(`${pc.green("PR opened")}  ${prUrl}`);
          return;
        }

        console.log(
          `${pc.bold("destination:")} ${space.name} ${pc.dim(`(${space.manifest.kind} space — readable by ${KIND_READERSHIP[space.manifest.kind]})`)}`,
        );
        console.log(`${pc.bold("record:")}      [${record.fm.type}] ${record.fm.title}`);
        console.log(
          `${pc.bold("project:")}     ${record.fm.project}   ${pc.bold("author:")} ${record.fm.provenance.author}`,
        );
        if (scanResult.warns.length > 0) {
          console.log(pc.yellow(`${scanResult.warns.length} warning(s):`));
          for (const w of scanResult.warns)
            console.log(pc.yellow(`  WARN ${w.ruleId} @ line ${w.line}: ${w.excerpt}`));
        }

        if (!opts.yes) {
          if (!process.stdout.isTTY)
            throw new CliError("not a TTY — pass --yes to publish non-interactively");
          console.log(pc.dim("\n--- full body (what you approve is what ships) ---"));
          console.log(record.body);
          console.log(pc.dim("--- end body ---\n"));
          const ok = await confirm({ message: `Publish to '${space.name}'?` });
          if (isCancel(ok) || !ok) {
            console.log(pc.dim("not published"));
            return;
          }
        }

        const outcome = commitAndPush(ctx, record, space);

        // Proposal bookkeeping: close any open proposal for this destination.
        const open = ctx.index.findOpenProposal(id, space.name);
        if (open) ctx.index.updateProposalState(open.id, "published", nowIso());

        appendAudit(
          {
            action: "publish",
            record_id: id,
            space: space.name,
            commit: outcome.commit,
            details: { warns: scanResult.warns.length, policy: space.manifest.publish },
          },
          ctx.paths.auditPath,
        );
        console.log(
          `${pc.green("published")} ${id} → '${space.name}' ${pc.dim(`@${outcome.commit.slice(0, 8)}`)}`,
        );
      });
    });
}
