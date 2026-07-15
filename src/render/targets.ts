import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IndexDb } from "../core/index-db.js";
import { applyBlock } from "./managed-block.js";
import { composeProjection, selectProjectionRecords } from "./projection.js";

export interface RenderTargetResult {
  file: string;
  action: "created" | "updated" | "unchanged";
}

export interface RenderOptions {
  claudeMd?: boolean;
  force?: boolean;
  /** Check mode: report what would change, write nothing. */
  check?: boolean;
  /** Record ids to exclude (quarantine kill-switch). */
  exclude?: ReadonlySet<string>;
}

/**
 * Render the managed block into a project's instruction files (RFC §10).
 * Default target is AGENTS.md only — Claude Code reads AGENTS.md too, so a
 * CLAUDE.md block would double the context tokens. --claude-md opts in.
 */
export function renderProject(
  index: IndexDb,
  projectDir: string,
  projectSlug: string,
  spaces: string[],
  opts: RenderOptions = {},
): RenderTargetResult[] {
  const records = selectProjectionRecords(index, projectSlug, spaces, opts.exclude);
  const content = composeProjection(records);
  const targets = ["AGENTS.md", ...(opts.claudeMd ? ["CLAUDE.md"] : [])];
  const results: RenderTargetResult[] = [];
  for (const name of targets) {
    const file = join(projectDir, name);
    const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const { text, action } = applyBlock(existing, content, { force: opts.force });
    if (action !== "unchanged" && !opts.check) writeFileSync(file, text);
    results.push({ file, action });
  }
  return results;
}
