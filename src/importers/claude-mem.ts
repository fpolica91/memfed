import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAuthor } from "../core/config.js";
import { openDb } from "../core/db.js";
import { contentHash } from "../core/record.js";
import type { Store } from "../core/store.js";
import type { RecordType } from "../core/types.js";

/**
 * claude-mem importer (RFC §13.1): read-only over ~/.claude-mem/claude-mem.db.
 * Imported observations land PRIVATE with status: candidate — importing never
 * publishes anything (INV-1). claude-mem's `project` is a cwd basename (its
 * documented collision footgun); --map renames it into a proper slug.
 */

export const CLAUDE_MEM_DEFAULT_DB = join(homedir(), ".claude-mem", "claude-mem.db");

/** claude-mem observation type -> memfed record type. Original kept as a cm:<type> tag. */
const TYPE_MAP: Record<string, RecordType> = {
  decision: "decision",
  bugfix: "gotcha",
  discovery: "reference",
  change: "reference",
  feature: "reference",
  refactor: "reference",
};

export interface ClaudeMemImportOptions {
  dbPath?: string;
  /** Observation types to import; default ['decision'] (a reviewable sitting). */
  types?: string[];
  /** cwd-basename -> project slug renames. */
  map?: Record<string, string>;
  limit?: number;
}

export interface ImportResult {
  imported: number;
  skippedDuplicates: number;
  skippedInvalid: number;
  total: number;
}

interface ObservationRow {
  id: number;
  project: string | null;
  merged_into_project: string | null;
  title: string | null;
  subtitle: string | null;
  text: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  type: string;
  created_at_epoch: number | null;
}

function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return slug || "unknown";
}

function composeBody(row: ObservationRow): string {
  const parts: string[] = [];
  if (row.subtitle?.trim()) parts.push(row.subtitle.trim());
  const main = row.narrative?.trim() || row.text?.trim();
  if (main) parts.push(main);
  if (row.facts?.trim()) {
    try {
      const facts = JSON.parse(row.facts);
      if (Array.isArray(facts) && facts.length > 0)
        parts.push(facts.map((f: unknown) => `- ${String(f)}`).join("\n"));
    } catch {
      parts.push(row.facts.trim());
    }
  }
  return parts.join("\n\n") || "(empty observation)";
}

function epochToIso(epoch: number | null): string {
  const d = epoch ? new Date(epoch < 10_000_000_000 ? epoch * 1000 : epoch) : new Date();
  return `${d.toISOString().slice(0, 19)}Z`;
}

/** Open the source db read-only; on a hard lock, snapshot db(+wal/shm) and read the copy. */
async function openSource(dbPath: string, tmpDir: string) {
  try {
    return { db: await openDb(dbPath, { readOnly: true }), snapshot: undefined as string | undefined };
  } catch {
    mkdirSync(tmpDir, { recursive: true });
    const snap = join(tmpDir, `claude-mem-snapshot-${process.pid}.db`);
    copyFileSync(dbPath, snap);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, snap + suffix);
    }
    return { db: await openDb(snap, { readOnly: true }), snapshot: snap };
  }
}

export async function importClaudeMem(
  store: Store,
  opts: ClaudeMemImportOptions = {},
): Promise<ImportResult> {
  const dbPath = opts.dbPath ?? CLAUDE_MEM_DEFAULT_DB;
  if (!existsSync(dbPath)) throw new Error(`claude-mem database not found at ${dbPath}`);
  const types = opts.types?.includes("all")
    ? Object.keys(TYPE_MAP)
    : (opts.types ?? ["decision"]);
  for (const t of types)
    if (!TYPE_MAP[t]) throw new Error(`unknown claude-mem type '${t}' (known: ${Object.keys(TYPE_MAP).join(", ")}, all)`);

  const tmpDir = join(store.paths.home, "tmp");
  const { db, snapshot } = await openSource(dbPath, tmpDir);
  const result: ImportResult = { imported: 0, skippedDuplicates: 0, skippedInvalid: 0, total: 0 };
  try {
    const placeholders = types.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT id, project, merged_into_project, title, subtitle, text, narrative, facts, concepts, type, created_at_epoch
         FROM observations WHERE type IN (${placeholders})
         ORDER BY created_at_epoch ASC ${opts.limit ? `LIMIT ${Number(opts.limit)}` : ""}`,
      )
      .all(...types) as unknown as ObservationRow[];
    result.total = rows.length;
    const author = resolveAuthor(store.config);

    for (const row of rows) {
      const rawProject = row.merged_into_project ?? row.project ?? "unknown";
      const project = opts.map?.[rawProject] ?? slugify(rawProject);
      const title = row.title?.trim() || undefined;
      const body = composeBody(row);
      if (body.length < 8) {
        result.skippedInvalid++;
        continue;
      }
      const tags = [`cm:${row.type}`];
      try {
        const concepts = row.concepts ? JSON.parse(row.concepts) : [];
        if (Array.isArray(concepts)) tags.push(...concepts.slice(0, 6).map((c: unknown) => slugify(String(c))));
      } catch {
        /* concepts unparseable — fine */
      }

      const probe = {
        fm: {
          id: "01AAAAAAAAAAAAAAAAAAAAAAAA",
          title: title ?? body.split("\n")[0]?.slice(0, 120) ?? "untitled",
          type: TYPE_MAP[row.type] as RecordType,
          project,
          provenance: { author, tool: "import:claude-mem", created: epochToIso(row.created_at_epoch) },
          status: "candidate" as const,
          schema_version: 1 as const,
        },
        body,
      };
      if (store.index.findByContentHash(contentHash(probe)).length > 0) {
        result.skippedDuplicates++;
        continue;
      }
      try {
        store.create({
          title,
          type: TYPE_MAP[row.type],
          project,
          body,
          tags,
          status: "candidate",
          provenance: {
            author,
            tool: "import:claude-mem",
            created: epochToIso(row.created_at_epoch),
          },
        });
        result.imported++;
      } catch {
        result.skippedInvalid++;
      }
    }
  } finally {
    db.close();
    if (snapshot) rmSync(snapshot, { force: true });
  }
  return result;
}
