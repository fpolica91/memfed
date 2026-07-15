import { createHash } from "node:crypto";

/**
 * Managed projection block (RFC §10). The begin marker carries a hash of the
 * block content so hand-edits are detected; text outside the markers is never
 * touched; a missing end marker always refuses (we never destroy user content).
 */

const BEGIN_RE = /^<!-- memfed:begin v1 sha256:([0-9a-f]{16}) -->$/m;
const END_MARKER = "<!-- memfed:end -->";

export function blockHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function renderBlock(content: string): string {
  return `<!-- memfed:begin v1 sha256:${blockHash(content)} -->\n${content}\n${END_MARKER}`;
}

export interface FoundBlock {
  begin: number;
  end: number;
  content: string;
  tampered: boolean;
}

export class DamagedBlockError extends Error {
  constructor() {
    super(
      "found a memfed:begin marker without a matching memfed:end — refusing to touch this file; remove the stray marker by hand",
    );
    this.name = "DamagedBlockError";
  }
}

/** Locate the managed block. Throws DamagedBlockError when begin exists without end. */
export function findBlock(text: string): FoundBlock | undefined {
  const beginMatch = BEGIN_RE.exec(text);
  if (!beginMatch) {
    if (text.includes(END_MARKER) || text.includes("<!-- memfed:begin"))
      throw new DamagedBlockError();
    return undefined;
  }
  const contentStart = (beginMatch.index ?? 0) + beginMatch[0].length + 1; // past newline
  const endIdx = text.indexOf(`\n${END_MARKER}`, contentStart - 1);
  if (endIdx === -1) throw new DamagedBlockError();
  const content = text.slice(contentStart, endIdx);
  return {
    begin: beginMatch.index ?? 0,
    end: endIdx + 1 + END_MARKER.length,
    content,
    tampered: blockHash(content) !== beginMatch[1],
  };
}

export interface ApplyResult {
  text: string;
  action: "created" | "updated" | "unchanged";
}

/**
 * Insert or replace the managed block in a file's text.
 * - no file/none present: append (blank-line separated)
 * - present + hash matches: replace
 * - present + hash mismatch (user edited inside): refuse unless force
 */
export function applyBlock(
  existing: string | undefined,
  newContent: string,
  opts: { force?: boolean } = {},
): ApplyResult {
  const block = renderBlock(newContent);
  if (existing === undefined || existing.trim() === "") {
    return { text: `${block}\n`, action: "created" };
  }
  const found = findBlock(existing);
  if (!found) {
    const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return { text: `${existing}${sep}${block}\n`, action: "created" };
  }
  if (found.tampered && !opts.force) {
    throw new Error(
      "the managed block was edited by hand (hash mismatch) — refusing to overwrite; re-run with --force to regenerate (hand edits inside the block are always lost on regeneration; put notes outside the markers)",
    );
  }
  if (found.content === newContent) return { text: existing, action: "unchanged" };
  const text = existing.slice(0, found.begin) + block + existing.slice(found.end);
  return { text, action: "updated" };
}
