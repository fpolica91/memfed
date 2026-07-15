import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../cli/util.js";
import { CliError } from "../cli/util.js";
import { appendAudit } from "../core/audit.js";
import type { IndexDb } from "../core/index-db.js";
import { parseRecord } from "../core/record.js";
import { aheadCount, changedFiles, git, isAncestor, revParse, sleepJitter } from "./exec.js";
import { getPin, indexedShaKey, pinSpace, reindexSpace, type Space } from "./space.js";

export interface SyncResult {
  space: string;
  pulled: number;
  removed: number;
  pushed: boolean;
  errors: Array<{ file: string; error: string }>;
}

/**
 * Sync one space (RFC §8): fetch → TOFU pin check → rebase local commits →
 * push → incremental reindex from the pulled diff.
 */
export function syncSpace(
  ctx: Ctx,
  space: Space,
  opts: { acceptRewrite?: boolean } = {},
): SyncResult {
  const result: SyncResult = {
    space: space.name,
    pulled: 0,
    removed: 0,
    pushed: false,
    errors: [],
  };

  git(["fetch", "-q", "origin"], { cwd: space.dir });
  const remoteMain = revParse(space.dir, "origin/main");
  if (!remoteMain) throw new CliError(`space '${space.name}': origin has no main branch`);

  // TOFU pinning: a non-fast-forward remote main means history was rewritten.
  const pin = getPin(ctx.paths, space.name);
  if (pin && !isAncestor(space.dir, pin, remoteMain)) {
    if (!opts.acceptRewrite) {
      throw new CliError(
        `REFUSING TO SYNC '${space.name}': remote history was REWRITTEN.\n` +
          `  pinned:  ${pin}\n  remote:  ${remoteMain}\n` +
          `This is what tampering looks like (RFC §16 T4). If the rewrite is expected\n` +
          `(deliberate maintenance), re-run: memfed sync ${space.name} --accept-rewrite`,
      );
    }
    appendAudit(
      { action: "rewrite-accepted", space: space.name, details: { from: pin, to: remoteMain } },
      ctx.paths.auditPath,
    );
    // Accepting a rewrite means adopting the remote's new truth wholesale.
    // Local unpushed publishes are dropped from the clone — their private
    // copies are untouched in the store and can be re-shared.
    git(["reset", "--hard", "origin/main"], { cwd: space.dir });
    const full = reindexSpace(ctx.index, space);
    result.pulled = full.count;
    result.errors.push(...full.errors);
    pinSpace(ctx.paths, space.name, remoteMain);
    appendAudit(
      { action: "sync", space: space.name, details: { pulled: result.pulled, rewrite: true } },
      ctx.paths.auditPath,
    );
    return result;
  }

  // Integrate remote changes; keep any local unpushed publish commits on top.
  if (aheadCount(space.dir, "origin/main") > 0) {
    const rebase = git(["rebase", "origin/main"], { cwd: space.dir, check: false });
    if (rebase.code !== 0) {
      git(["rebase", "--abort"], { cwd: space.dir, check: false });
      throw new CliError(
        `space '${space.name}': local commits conflict with remote — field-wise merge lands in M4; ` +
          `inspect ${space.dir} manually for now`,
      );
    }
    for (let attempt = 1; attempt <= 4; attempt++) {
      const push = git(["push", "-q", "origin", "main"], { cwd: space.dir, check: false });
      if (push.code === 0) {
        result.pushed = true;
        break;
      }
      if (attempt === 4)
        throw new CliError(`space '${space.name}': push failed: ${push.stderr.trim()}`);
      git(["fetch", "-q", "origin"], { cwd: space.dir });
      const retry = git(["rebase", "origin/main"], { cwd: space.dir, check: false });
      if (retry.code !== 0) {
        git(["rebase", "--abort"], { cwd: space.dir, check: false });
        throw new CliError(`space '${space.name}': rebase conflict during push retry`);
      }
      sleepJitter(attempt);
    }
  } else {
    git(["merge", "--ff-only", "-q", "origin/main"], { cwd: space.dir });
  }

  const head = revParse(space.dir, "HEAD");
  pinSpace(ctx.paths, space.name, revParse(space.dir, "origin/main") ?? head);

  // Incremental reindex from the last-INDEXED commit (not git state): publishes
  // and rebase-retries move HEAD without indexing what they pulled in.
  const indexedSha = ctx.index.getMeta(indexedShaKey(space.name));
  if (head && indexedSha !== head) {
    if (!indexedSha) {
      const full = reindexSpace(ctx.index, space);
      result.pulled = full.count;
      result.errors.push(...full.errors);
    } else {
      try {
        applyDiffToIndex(ctx.index, space, indexedSha, head, result);
        ctx.index.setMeta(indexedShaKey(space.name), head);
      } catch {
        const full = reindexSpace(ctx.index, space);
        result.pulled = full.count;
        result.errors.push(...full.errors);
      }
    }
  }

  appendAudit(
    {
      action: "sync",
      space: space.name,
      details: { pulled: result.pulled, removed: result.removed, pushed: result.pushed },
    },
    ctx.paths.auditPath,
  );
  return result;
}

function applyDiffToIndex(
  index: IndexDb,
  space: Space,
  from: string,
  to: string,
  result: SyncResult,
): void {
  for (const line of changedFiles(space.dir, from, to)) {
    const [status, ...pathParts] = line.split("\t");
    const rel = pathParts[pathParts.length - 1];
    if (!rel || !rel.startsWith("records/") || !rel.endsWith(".md")) continue;
    const id = rel.slice("records/".length, -3);
    if (status?.startsWith("D")) {
      index.removeRecord(space.name, id);
      result.removed++;
      continue;
    }
    const file = join(space.dir, rel);
    if (!existsSync(file)) continue;
    try {
      const record = parseRecord(readFileSync(file, "utf8"), file);
      index.upsertRecord(space.name, record, file);
      result.pulled++;
    } catch (e) {
      result.errors.push({ file, error: (e as Error).message });
    }
  }
}
