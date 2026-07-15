import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  FRONTMATTER_KEY_ORDER,
  formatZodError,
  MAX_BODY_BYTES,
  type MemoryRecord,
  type RecordFrontmatter,
  RecordFrontmatterSchema,
} from "./types.js";

export class RecordParseError extends Error {
  constructor(
    message: string,
    public readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
    this.name = "RecordParseError";
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Normalize a frontmatter object into canonical shape (RFC §4.2):
 * canonical key order, omitted empties, sorted+deduped lists.
 */
export function normalizeFrontmatter(fm: RecordFrontmatter): RecordFrontmatter {
  const out: Partial<RecordFrontmatter> = {};
  for (const key of FRONTMATTER_KEY_ORDER) {
    const value = fm[key as keyof RecordFrontmatter];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      (out as Record<string, unknown>)[key] = sortedUnique(value as string[]);
    } else if (key === "provenance") {
      const p = fm.provenance;
      out.provenance = { author: p.author, tool: p.tool, created: p.created };
    } else {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out as RecordFrontmatter;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").trim();
}

/** Canonical serialization (RFC §4.2). Byte-stable: serialize(parse(x)) === x for canonical files. */
export function serializeRecord(record: MemoryRecord): string {
  const fm = normalizeFrontmatter(record.fm);
  const body = normalizeBody(record.body);
  if (body.length === 0) throw new RecordParseError("record body must not be empty");
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES)
    throw new RecordParseError(`record body exceeds ${MAX_BODY_BYTES} bytes`);
  const yamlText = stringifyYaml(fm, { lineWidth: 0 });
  return `---\n${yamlText}---\n\n${body}\n`;
}

/** Parse a record file. Unknown frontmatter fields are stripped (forward-compat, RFC §15). */
export function parseRecord(text: string, file?: string): MemoryRecord {
  if (!text.startsWith("---\n"))
    throw new RecordParseError("missing frontmatter opening '---'", file);
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) throw new RecordParseError("missing frontmatter closing '---'", file);
  const yamlText = text.slice(4, end + 1);
  const rest = text.slice(end + 5);

  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new RecordParseError(`invalid YAML frontmatter: ${(e as Error).message}`, file);
  }
  const parsed = RecordFrontmatterSchema.safeParse(raw);
  if (!parsed.success) throw new RecordParseError(formatZodError(parsed.error), file);

  const body = normalizeBody(rest);
  if (body.length === 0) throw new RecordParseError("record body must not be empty", file);
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES)
    throw new RecordParseError(`record body exceeds ${MAX_BODY_BYTES} bytes`, file);
  if (parsed.data.id !== parsed.data.id.toUpperCase())
    throw new RecordParseError("record id must be uppercase", file);

  return { fm: parsed.data, body };
}

/** Content hash for dedup and cross-space identity (index-time only; never stored in the file). */
export function contentHash(record: MemoryRecord): string {
  const h = createHash("sha256");
  h.update(record.fm.title.trim());
  h.update("\n\n");
  h.update(normalizeBody(record.body));
  return h.digest("hex");
}

export function recordFileName(id: string): string {
  return `${id}.md`;
}
