import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../cli/util.js";
import { CliError } from "../cli/util.js";
import { appendAudit } from "../core/audit.js";
import { parseRecord, serializeRecord } from "../core/record.js";
import type { MemoryRecord } from "../core/types.js";
import { git, pushMainWithRetry, revParse } from "./exec.js";
import { recordRelPath, type Space } from "./space.js";

/**
 * Forge-independent PR flow (RFC §7.5): proposals are branches named
 * memfed/proposals/<ulid> on the space remote. Approval = merging to main,
 * which requires push permission — the existing git ACL IS the approval right.
 * Built with plumbing so the clone's main checkout is never disturbed.
 */

export const PROPOSAL_REF_PREFIX = "refs/heads/memfed/proposals/";

export function proposalBranch(id: string): string {
  return `memfed/proposals/${id}`;
}

/** Create and push a proposal branch containing exactly one new record (no checkout churn). */
export function pushProposalBranch(ctx: Ctx, record: MemoryRecord, space: Space): string {
  git(["fetch", "-q", "origin"], { cwd: space.dir });
  const base = revParse(space.dir, "origin/main");
  if (!base) throw new CliError(`space '${space.name}': origin has no main branch`);

  const blob = git(["hash-object", "-w", "--stdin"], {
    cwd: space.dir,
    input: serializeRecord(record),
  }).stdout.trim();

  const tmpIndex = join(ctx.paths.home, `.tmp-index-${process.pid}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    git(["read-tree", base], { cwd: space.dir, env });
    git(
      [
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${blob},${recordRelPath(space, record.fm.id)}`,
      ],
      { cwd: space.dir, env },
    );
    const tree = git(["write-tree"], { cwd: space.dir, env }).stdout.trim();
    const title = record.fm.title.replace(/\s+/g, " ").slice(0, 72);
    const commit = git(
      [
        "commit-tree",
        tree,
        "-p",
        base,
        "-m",
        `memfed: propose ${record.fm.id.slice(0, 10)} — ${title}`,
      ],
      { cwd: space.dir },
    ).stdout.trim();
    git(["push", "-q", "origin", `${commit}:${PROPOSAL_REF_PREFIX}${record.fm.id}`], {
      cwd: space.dir,
    });
    return commit;
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

export interface RemoteProposal {
  recordId: string;
  sha: string;
}

export function listRemoteProposals(space: Space): RemoteProposal[] {
  const out = git(["ls-remote", "origin", `${PROPOSAL_REF_PREFIX}*`], { cwd: space.dir }).stdout;
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split("\t");
      return { recordId: (ref ?? "").slice(PROPOSAL_REF_PREFIX.length), sha: (sha ?? "").trim() };
    })
    .filter((p) => p.recordId.length === 26);
}

/** Read the proposed record's content out of the proposal commit. */
export function readProposalRecord(space: Space, proposal: RemoteProposal): MemoryRecord {
  git(["fetch", "-q", "origin", `${PROPOSAL_REF_PREFIX}${proposal.recordId}`], { cwd: space.dir });
  const text = git(["show", `${proposal.sha}:${recordRelPath(space, proposal.recordId)}`], {
    cwd: space.dir,
  }).stdout;
  return parseRecord(text, `proposal ${proposal.recordId}`);
}

/** Merge a proposal into main (approval) and delete the remote branch. */
export function mergeProposal(ctx: Ctx, space: Space, proposal: RemoteProposal): string {
  git(["fetch", "-q", "origin"], { cwd: space.dir });
  git(["merge", "--ff-only", "-q", "origin/main"], { cwd: space.dir, check: false });
  const merge = git(
    ["merge", "-q", "-m", `memfed: approve ${proposal.recordId.slice(0, 10)}`, proposal.sha],
    { cwd: space.dir, check: false },
  );
  if (merge.code !== 0) {
    git(["merge", "--abort"], { cwd: space.dir, check: false });
    throw new CliError(
      `approving ${proposal.recordId} conflicts with main in '${space.name}' — sync and retry`,
    );
  }
  pushMainWithRetry(space.dir, `approval of ${proposal.recordId}`);
  git(["push", "-q", "origin", `:${PROPOSAL_REF_PREFIX}${proposal.recordId}`], {
    cwd: space.dir,
    check: false, // branch may already be gone; the merge is what matters
  });
  const head = revParse(space.dir, "HEAD") ?? "";
  appendAudit(
    { action: "approve", record_id: proposal.recordId, space: space.name, commit: head },
    ctx.paths.auditPath,
  );
  return head;
}

/** Reject a proposal: delete the remote branch (audited); nothing lands on main. */
export function rejectProposal(ctx: Ctx, space: Space, recordId: string): void {
  git(["push", "-q", "origin", `:${PROPOSAL_REF_PREFIX}${recordId}`], { cwd: space.dir });
  appendAudit({ action: "reject", record_id: recordId, space: space.name }, ctx.paths.auditPath);
}

/**
 * Forge sugar (RFC §7.5): when the remote is GitHub and `gh` is available,
 * open a PR for the proposal branch so review can happen in the forge UI.
 * Pure convenience — the branch flow above is the real mechanism.
 */
export function tryCreateForgePr(space: Space, record: MemoryRecord): string | undefined {
  const url = git(["remote", "get-url", "origin"], { cwd: space.dir, check: false }).stdout.trim();
  if (!/github\.com/.test(url)) return undefined;
  try {
    execFileSync("which", ["gh"], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    return undefined;
  }
  try {
    const title = record.fm.title.replace(/\s+/g, " ").slice(0, 72);
    const out = execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--head",
        proposalBranch(record.fm.id),
        "--title",
        `memfed: propose ${record.fm.id.slice(0, 10)} — ${title}`,
        "--body",
        `Proposed memory record \`${record.fm.id}\` ([${record.fm.type}] by ${record.fm.provenance.author}).\n\nApprove with \`memfed approve ${record.fm.id.slice(0, 10)} --space ${space.name}\` or merge here.`,
      ],
      { cwd: space.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.trim().split("\n").pop();
  } catch {
    return undefined; // sugar never fails the publish flow
  }
}
