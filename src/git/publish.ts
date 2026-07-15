import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { appendAudit } from "../core/audit.js";
import { resolveAuthor } from "../core/config.js";
import { serializeRecord } from "../core/record.js";
import type { MemoryRecord } from "../core/types.js";
import { loadAllowlist, RULESET_VERSION, scan, type ScanResult } from "../redact/scan.js";
import type { Ctx } from "../cli/util.js";
import { CliError, EXIT_REDACTION_BLOCK } from "../cli/util.js";
import { git, revParse, sleepJitter } from "./exec.js";
import type { Space } from "./space.js";
import { pinSpace } from "./space.js";

export interface PublishOutcome {
  commit: string;
  warnsAcked: number;
}

/**
 * THE publish pipeline (RFC §7.4-7.5). The boundary re-validates everything:
 * it never trusts the proposal — policy is re-read from the space's own manifest,
 * redaction re-runs on the exact bytes to be committed, authorship is re-stamped
 * from git config. BLOCK findings are non-skippable (INV-3).
 */
export function runRedactionGate(
  ctx: Ctx,
  record: MemoryRecord,
  space: Space,
): ScanResult {
  if (RULESET_VERSION < space.manifest.redaction.ruleset_min_version) {
    throw new CliError(
      `space '${space.name}' requires redaction ruleset >= v${space.manifest.redaction.ruleset_min_version}; this memfed ships v${RULESET_VERSION} — upgrade memfed`,
    );
  }
  const allow = loadAllowlist(join(ctx.paths.home, "redaction-allow.json"));
  const text = serializeRecord(record);
  const result = scan(text, { selfAuthor: record.fm.provenance.author, allow });

  if (result.blocks.length > 0) {
    appendAudit(
      {
        action: "redaction-block",
        record_id: record.fm.id,
        space: space.name,
        findings: result.blocks.map((f) => ({
          ruleId: f.ruleId,
          fingerprint: f.fingerprint,
          excerpt: f.excerpt,
        })),
      },
      ctx.paths.auditPath,
    );
    const lines = result.blocks
      .map((f) => `  ${pc.red("BLOCK")} ${f.ruleId} @ line ${f.line}: ${f.excerpt} — ${f.description}`)
      .join("\n");
    throw new CliError(
      `refusing to publish ${record.fm.id} to '${space.name}' — secret-shaped content found:\n${lines}\n` +
        `${pc.dim("fix the body ('memfed edit'), or allowlist a false positive in ~/.memfed/redaction-allow.json")}`,
      EXIT_REDACTION_BLOCK,
    );
  }
  return result;
}

/** Copy the record into the space clone, commit, push with fetch/rebase retry. */
export function commitAndPush(
  ctx: Ctx,
  record: MemoryRecord,
  space: Space,
  opts: { message?: string } = {},
): PublishOutcome {
  const relPath = join("records", `${record.fm.id}.md`);
  const absPath = join(space.dir, relPath);
  const text = serializeRecord(record);
  writeFileSync(absPath, text);

  git(["add", relPath], { cwd: space.dir });
  const title = record.fm.title.replace(/\s+/g, " ").slice(0, 72);
  const staged = git(["diff", "--cached", "--quiet"], { cwd: space.dir, check: false });
  if (staged.code === 0) {
    // Nothing changed — identical record already published (idempotent republish, RFC §7.2).
    const head = revParse(space.dir, "HEAD") ?? "";
    ctx.index.upsertRecord(space.name, record, absPath);
    return { commit: head, warnsAcked: 0 };
  }
  git(
    ["commit", "-q", "-m", opts.message ?? `memfed: publish ${record.fm.id.slice(0, 10)} — ${title}`],
    { cwd: space.dir },
  );

  let lastError = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const push = git(["push", "-q", "origin", "main"], { cwd: space.dir, check: false });
    if (push.code === 0) {
      const commit = revParse(space.dir, "HEAD") ?? "";
      pinSpace(ctx.paths, space.name, revParse(space.dir, "origin/main") ?? commit);
      ctx.index.upsertRecord(space.name, record, absPath);
      return { commit, warnsAcked: 0 };
    }
    lastError = push.stderr;
    if (attempt === 4) break;
    // Non-fast-forward: someone else published concurrently. Fetch, rebase our
    // append-only commit (new ULID file — structurally conflict-free), retry.
    git(["fetch", "-q", "origin"], { cwd: space.dir });
    const rebase = git(["rebase", "origin/main"], { cwd: space.dir, check: false });
    if (rebase.code !== 0) {
      git(["rebase", "--abort"], { cwd: space.dir, check: false });
      throw new CliError(
        `publish race produced a real conflict in space '${space.name}' — run 'memfed sync ${space.name}' and retry`,
      );
    }
    sleepJitter(attempt);
  }
  throw new CliError(`push to '${space.name}' failed after retries: ${lastError.trim()}`);
}

/** Full direct publish: redaction gate → commit+push → index → audit. */
export function publishRecord(
  ctx: Ctx,
  record: MemoryRecord,
  space: Space,
): PublishOutcome {
  const scanResult = runRedactionGate(ctx, record, space);
  const outcome = commitAndPush(ctx, record, space);
  appendAudit(
    {
      action: "publish",
      record_id: record.fm.id,
      space: space.name,
      commit: outcome.commit,
      details: {
        author: resolveAuthor(ctx.config),
        warns: scanResult.warns.length,
        policy: space.manifest.publish,
      },
    },
    ctx.paths.auditPath,
  );
  return { ...outcome, warnsAcked: scanResult.warns.length };
}
