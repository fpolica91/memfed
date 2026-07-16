import { join } from "node:path";
import { confirm, isCancel, select } from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { appendAudit } from "../../core/audit.js";
import { LOCAL_SOURCE } from "../../core/index-db.js";
import { nowIso, type Proposal } from "../../core/types.js";
import {
  listRemoteProposals,
  mergeProposal,
  pushProposalBranch,
  readProposalRecord,
  rejectProposal,
} from "../../git/proposals.js";
import { commitAndPush, runRedactionGate } from "../../git/publish.js";
import { contentDir, loadSpace } from "../../git/space.js";
import { scan } from "../../redact/scan.js";
import { CliError, type Ctx, openCtx, resolveId } from "../util.js";

const EXPIRY_DAYS = 30;

async function withCtx<T>(fn: (ctx: Ctx) => Promise<T> | T): Promise<T> {
  const ctx = await openCtx();
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

/** Proposals untouched for 30 days expire back to private (RFC §7.2). */
function expireStale(ctx: Ctx): void {
  const cutoff = new Date(Date.now() - EXPIRY_DAYS * 86400_000).toISOString();
  for (const p of ctx.index.listProposals("proposed")) {
    if (p.updated < cutoff) {
      ctx.index.updateProposalState(p.id, "expired", nowIso());
      appendAudit(
        { action: "expire", record_id: p.record_id, space: p.space },
        ctx.paths.auditPath,
      );
    }
  }
}

function proposalSummary(ctx: Ctx, p: Proposal): string {
  const row = ctx.index.getById(p.record_id, LOCAL_SOURCE);
  const title = row ? `[${row.type}] ${row.title}` : "(record missing — reindex?)";
  return `${p.record_id.slice(0, 10)} → ${pc.bold(p.space)}  ${title}  ${pc.dim(`(staged by ${p.origin}, ${p.created.slice(0, 10)})`)}`;
}

/** Publish one local proposal through the full pipeline, honoring the space policy. */
function publishProposal(ctx: Ctx, p: Proposal): void {
  const record = ctx.store.get(p.record_id);
  const space = loadSpace(ctx.paths, ctx.config, p.space);
  const scanResult = runRedactionGate(ctx, record, space);
  if (space.manifest.publish === "pr") {
    const commit = pushProposalBranch(ctx, record, space);
    ctx.index.updateProposalState(p.id, "approved", nowIso());
    appendAudit(
      { action: "propose", record_id: p.record_id, space: p.space, commit, origin: "cli" },
      ctx.paths.auditPath,
    );
    console.log(
      `${pc.green("proposal pushed")} ${p.record_id} → '${p.space}' (awaits a maintainer's 'memfed approve')`,
    );
    return;
  }
  const outcome = commitAndPush(ctx, record, space);
  ctx.index.updateProposalState(p.id, "published", nowIso());
  appendAudit(
    {
      action: "publish",
      record_id: p.record_id,
      space: p.space,
      commit: outcome.commit,
      details: { warns: scanResult.warns.length, via: "review" },
    },
    ctx.paths.auditPath,
  );
  console.log(
    `${pc.green("published")} ${p.record_id} → '${p.space}' ${pc.dim(`@${outcome.commit.slice(0, 8)}`)}`,
  );
}

async function interactiveReview(ctx: Ctx, proposals: Proposal[]): Promise<void> {
  for (const p of proposals) {
    const row = ctx.index.getById(p.record_id, LOCAL_SOURCE);
    if (!row) {
      console.log(pc.yellow(`skip ${p.record_id}: record not in private index`));
      continue;
    }
    const space = loadSpace(ctx.paths, ctx.config, p.space);
    const record = ctx.store.get(p.record_id);
    const kind = space.manifest.kind;

    console.log(
      `\n${pc.bold("destination:")} ${p.space} ${pc.dim(`(${kind} space, publish=${space.manifest.publish})`)}`,
    );
    console.log(`${pc.bold("record:")}      [${row.type}] ${row.title}`);
    console.log(
      `${pc.bold("provenance:")}  ${row.author} via ${row.tool}, ${row.created.slice(0, 10)}`,
    );
    console.log(pc.dim("--- full body (what you approve is what ships) ---"));
    console.log(record.body);
    console.log(pc.dim("--- end body ---"));

    const scanResult = scan(record.body, { selfAuthor: record.fm.provenance.author });
    for (const f of scanResult.blocks)
      console.log(
        pc.red(`  BLOCK ${f.ruleId} @ line ${f.line}: ${f.excerpt} (${f.ruleId}:${f.fingerprint})`),
      );
    for (const f of scanResult.warns)
      console.log(pc.yellow(`  WARN ${f.ruleId} @ line ${f.line}: ${f.excerpt}`));

    // Similar records already in the destination (dedup-at-propose, RFC §7.6).
    const similar = ctx.index
      .search({ query: row.title, space: p.space, limit: 3 })
      .filter((s) => s.id !== row.id);
    if (similar.length > 0) {
      console.log(pc.dim("similar records already in the destination:"));
      for (const s of similar)
        console.log(pc.dim(`  - [${s.type}] ${s.title} (${s.id.slice(0, 10)})`));
    }

    const action = await select({
      message:
        kind === "org"
          ? `Publish to ORG space '${p.space}'? (broad readership)`
          : `Action for this proposal?`,
      options: [
        {
          value: "publish",
          label: scanResult.blocks.length ? "publish (blocked — will fail)" : "publish",
        },
        { value: "skip", label: "skip (keep staged)" },
        { value: "reject", label: "reject (back to private)" },
      ],
    });
    if (isCancel(action) || action === "skip") continue;
    if (action === "reject") {
      ctx.index.updateProposalState(p.id, "rejected", nowIso());
      appendAudit(
        { action: "reject", record_id: p.record_id, space: p.space },
        ctx.paths.auditPath,
      );
      console.log(pc.dim(`rejected ${p.record_id} (still private)`));
      continue;
    }
    if (kind === "org") {
      const sure = await confirm({ message: "Extra confirm for org-wide publication — proceed?" });
      if (isCancel(sure) || !sure) continue;
    }
    publishProposal(ctx, p);
  }
}

export function registerReviewCommands(program: Command): void {
  program
    .command("review")
    .description("review the local share queue, or a space's incoming proposal branches")
    .option("--space <name>", "review INCOMING proposals on a space remote")
    .option("--type <type>", "filter the local queue by record type")
    .action(async (opts) => {
      await withCtx(async (ctx) => {
        if (opts.space) {
          const space = loadSpace(ctx.paths, ctx.config, opts.space);
          const proposals = listRemoteProposals(space);
          if (proposals.length === 0) {
            console.log(pc.dim(`no incoming proposals on '${opts.space}'`));
            return;
          }
          for (const p of proposals) {
            try {
              const record = readProposalRecord(space, p);
              console.log(
                `${p.recordId.slice(0, 10)}  [${record.fm.type}] ${record.fm.title}  ${pc.dim(`by ${record.fm.provenance.author}`)}`,
              );
            } catch (e) {
              console.log(`${p.recordId.slice(0, 10)}  ${pc.red((e as Error).message)}`);
            }
          }
          console.log(
            pc.dim(
              `\napprove: memfed approve <id> --space ${opts.space}   reject: memfed reject <id> --space ${opts.space}`,
            ),
          );
          return;
        }

        expireStale(ctx);
        let queue = ctx.index.listProposals("proposed");
        if (opts.type)
          queue = queue.filter(
            (p) => ctx.index.getById(p.record_id, LOCAL_SOURCE)?.type === opts.type,
          );
        if (queue.length === 0) {
          console.log(pc.dim("share queue is empty"));
          return;
        }
        if (!process.stdout.isTTY) {
          for (const p of queue) console.log(proposalSummary(ctx, p));
          console.log(
            pc.dim(
              "\n(non-interactive: publish with 'memfed approve <id>' or 'memfed share <id> --to <space> --yes')",
            ),
          );
          return;
        }
        await interactiveReview(ctx, queue);
      });
    });

  program
    .command("approve <id>")
    .description("approve: publish a local staged proposal, or merge a space's incoming proposal")
    .option("--space <name>", "approve an INCOMING proposal branch on this space")
    .action(async (idArg, opts) => {
      await withCtx((ctx) => {
        if (opts.space) {
          const space = loadSpace(ctx.paths, ctx.config, opts.space);
          const proposals = listRemoteProposals(space);
          const hit = proposals.find((p) => p.recordId.startsWith(idArg.toUpperCase()));
          if (!hit)
            throw new CliError(`no incoming proposal matches '${idArg}' on '${opts.space}'`);
          const record = readProposalRecord(space, hit);
          // Reviewer-side re-validation: the approver's client re-runs the gate (RFC §7.4).
          runRedactionGate(ctx, record, space);
          const commit = mergeProposal(ctx, space, hit);
          ctx.index.upsertRecord(
            space.name,
            record,
            join(contentDir(space), "records", `${hit.recordId}.md`),
          );
          console.log(
            `${pc.green("approved")} ${hit.recordId} → '${opts.space}' main ${pc.dim(`@${commit.slice(0, 8)}`)}`,
          );
          return;
        }
        const id = resolveId(ctx, idArg);
        const open = ctx.index
          .listProposals("proposed")
          .find((p) => p.record_id === id || p.id === id);
        if (!open) throw new CliError(`no staged proposal for '${idArg}' — see 'memfed review'`);
        publishProposal(ctx, open);
      });
    });

  program
    .command("reject <id>")
    .description(
      "reject: drop a local staged proposal, or delete a space's incoming proposal branch",
    )
    .option("--space <name>", "reject an INCOMING proposal branch on this space")
    .action(async (idArg, opts) => {
      await withCtx((ctx) => {
        if (opts.space) {
          const space = loadSpace(ctx.paths, ctx.config, opts.space);
          const proposals = listRemoteProposals(space);
          const hit = proposals.find((p) => p.recordId.startsWith(idArg.toUpperCase()));
          if (!hit)
            throw new CliError(`no incoming proposal matches '${idArg}' on '${opts.space}'`);
          rejectProposal(ctx, space, hit.recordId);
          console.log(
            `${pc.green("rejected")} ${hit.recordId} (branch deleted; nothing landed on main)`,
          );
          return;
        }
        const id = resolveId(ctx, idArg);
        const open = ctx.index
          .listProposals("proposed")
          .find((p) => p.record_id === id || p.id === id);
        if (!open) throw new CliError(`no staged proposal for '${idArg}'`);
        ctx.index.updateProposalState(open.id, "rejected", nowIso());
        appendAudit(
          { action: "reject", record_id: open.record_id, space: open.space },
          ctx.paths.auditPath,
        );
        console.log(pc.dim(`rejected ${open.record_id} (still private)`));
      });
    });
}
