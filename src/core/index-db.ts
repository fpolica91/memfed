import { contentHash } from "./record.js";
import type { Db, SqlValue } from "./db.js";
import { openDb } from "./db.js";
import type { MemoryRecord, Proposal, ProposalState } from "./types.js";

export const INDEX_SCHEMA_VERSION = 1;

/** Source name for the private store; every space uses its own name. */
export const LOCAL_SOURCE = "local";

export interface IndexedRecord {
  id: string;
  source: string;
  title: string;
  type: string;
  project: string;
  status: string;
  author: string;
  tool: string;
  created: string;
  updated: string | null;
  tags: string[];
  paths: string[];
  review_after: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  body: string;
  content_hash: string;
  file_path: string;
  redaction_dirty: boolean;
  rank?: number;
}

export interface SearchFilters {
  query?: string;
  type?: string;
  project?: string;
  status?: string;
  /** Source filter: LOCAL_SOURCE or a space name. */
  space?: string;
  tag?: string;
  limit?: number;
}

const RECORDS_DDL = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  project TEXT NOT NULL,
  status TEXT NOT NULL,
  author TEXT NOT NULL,
  tool TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  paths TEXT NOT NULL DEFAULT '[]',
  review_after TEXT,
  supersedes TEXT,
  superseded_by TEXT,
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  file_path TEXT NOT NULL,
  redaction_dirty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, source)
);
CREATE INDEX IF NOT EXISTS idx_records_project ON records(project);
CREATE INDEX IF NOT EXISTS idx_records_hash ON records(content_hash);
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  id UNINDEXED, source UNINDEXED, title, body, tags, tokenize='porter unicode61'
);
`;

const PROPOSALS_DDL = `
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  space TEXT NOT NULL,
  state TEXT NOT NULL,
  origin TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class IndexDb {
  private constructor(private readonly db: Db) {}

  static async open(file: string): Promise<IndexDb> {
    const db = await openDb(file);
    db.exec(PROPOSALS_DDL);
    const idx = new IndexDb(db);
    const version = idx.getMeta("index_schema_version");
    if (version !== undefined && version !== String(INDEX_SCHEMA_VERSION)) {
      // The records index is a disposable cache: schema bump = rebuild (proposals survive).
      db.exec("DROP TABLE IF EXISTS records; DROP TABLE IF EXISTS records_fts;");
    }
    db.exec(RECORDS_DDL);
    idx.setMeta("index_schema_version", String(INDEX_SCHEMA_VERSION));
    return idx;
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? String(row.value) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  upsertRecord(source: string, record: MemoryRecord, filePath: string, redactionDirty = false): void {
    const { fm } = record;
    this.removeRecord(source, fm.id);
    this.db
      .prepare(
        `INSERT INTO records
         (id, source, title, type, project, status, author, tool, created, updated,
          tags, paths, review_after, supersedes, superseded_by, body, content_hash, file_path, redaction_dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fm.id,
        source,
        fm.title,
        fm.type,
        fm.project,
        fm.status,
        fm.provenance.author,
        fm.provenance.tool,
        fm.provenance.created,
        fm.updated ?? null,
        JSON.stringify(fm.tags ?? []),
        JSON.stringify(fm.paths ?? []),
        fm.review_after ?? null,
        fm.supersedes ?? null,
        fm.superseded_by ?? null,
        record.body,
        contentHash(record),
        filePath,
        redactionDirty ? 1 : 0,
      );
    this.db
      .prepare("INSERT INTO records_fts (id, source, title, body, tags) VALUES (?, ?, ?, ?, ?)")
      .run(fm.id, source, fm.title, record.body, (fm.tags ?? []).join(" "));
  }

  removeRecord(source: string, id: string): void {
    this.db.prepare("DELETE FROM records WHERE id = ? AND source = ?").run(id, source);
    this.db.prepare("DELETE FROM records_fts WHERE id = ? AND source = ?").run(id, source);
  }

  clearSource(source: string): void {
    this.db.prepare("DELETE FROM records WHERE source = ?").run(source);
    this.db.prepare("DELETE FROM records_fts WHERE source = ?").run(source);
  }

  listSources(): string[] {
    return this.db
      .prepare("SELECT DISTINCT source FROM records ORDER BY source")
      .all()
      .map((r) => String(r.source));
  }

  /** Sources (space names / 'local') a record id exists in. */
  sourcesForId(id: string): string[] {
    return this.db
      .prepare("SELECT source FROM records WHERE id = ? ORDER BY source")
      .all(id)
      .map((r) => String(r.source));
  }

  /** All ids for one source (used by prefix resolution). */
  idsForSource(source?: string): string[] {
    const rows = source
      ? this.db.prepare("SELECT DISTINCT id FROM records WHERE source = ?").all(source)
      : this.db.prepare("SELECT DISTINCT id FROM records").all();
    return rows.map((r) => String(r.id));
  }

  getById(id: string, source?: string): IndexedRecord | undefined {
    const row = source
      ? this.db.prepare("SELECT * FROM records WHERE id = ? AND source = ?").get(id, source)
      : this.db
          .prepare(
            `SELECT * FROM records WHERE id = ? ORDER BY CASE source WHEN '${LOCAL_SOURCE}' THEN 0 ELSE 1 END LIMIT 1`,
          )
          .get(id);
    return row ? toIndexed(row) : undefined;
  }

  findByContentHash(hash: string, source?: string): IndexedRecord[] {
    const rows = source
      ? this.db.prepare("SELECT * FROM records WHERE content_hash = ? AND source = ?").all(hash, source)
      : this.db.prepare("SELECT * FROM records WHERE content_hash = ?").all(hash);
    return rows.map(toIndexed);
  }

  search(filters: SearchFilters): IndexedRecord[] {
    const limit = filters.limit ?? 20;
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filters.type) {
      where.push("r.type = ?");
      params.push(filters.type);
    }
    if (filters.project) {
      where.push("r.project = ?");
      params.push(filters.project);
    }
    if (filters.status) {
      where.push("r.status = ?");
      params.push(filters.status);
    }
    if (filters.space) {
      where.push("r.source = ?");
      params.push(filters.space);
    }
    if (filters.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(r.tags) WHERE json_each.value = ?)");
      params.push(filters.tag);
    }

    if (filters.query?.trim()) {
      const match = ftsQuery(filters.query);
      const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";
      const sql = `
        SELECT r.*, f.rank AS rank FROM (
          SELECT id, source, bm25(records_fts, 0, 0, 8.0, 1.0, 4.0) AS rank
          FROM records_fts WHERE records_fts MATCH ?
        ) f
        JOIN records r ON r.id = f.id AND r.source = f.source
        WHERE 1=1 ${whereSql}
        ORDER BY f.rank LIMIT ?`;
      try {
        return this.db.prepare(sql).all(match, ...params, limit).map(toIndexed);
      } catch {
        // FTS syntax edge case: fall back to LIKE.
        const likeSql = `
          SELECT r.* FROM records r
          WHERE (r.title LIKE ? OR r.body LIKE ?) ${where.length ? `AND ${where.join(" AND ")}` : ""}
          ORDER BY r.created DESC LIMIT ?`;
        const like = `%${filters.query.trim()}%`;
        return this.db.prepare(likeSql).all(like, like, ...params, limit).map(toIndexed);
      }
    }

    const sql = `
      SELECT r.* FROM records r
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY r.created DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, limit).map(toIndexed);
  }

  // ---- proposals (durable state; survives reindex) ----

  insertProposal(p: Proposal): void {
    this.db
      .prepare(
        "INSERT INTO proposals (id, record_id, space, state, origin, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(p.id, p.record_id, p.space, p.state, p.origin, p.created, p.updated);
  }

  updateProposalState(id: string, state: ProposalState, updated: string): void {
    this.db.prepare("UPDATE proposals SET state = ?, updated = ? WHERE id = ?").run(state, updated, id);
  }

  getProposal(id: string): Proposal | undefined {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id);
    return row ? (row as unknown as Proposal) : undefined;
  }

  listProposals(state?: ProposalState): Proposal[] {
    const rows = state
      ? this.db.prepare("SELECT * FROM proposals WHERE state = ? ORDER BY created").all(state)
      : this.db.prepare("SELECT * FROM proposals ORDER BY created").all();
    return rows as unknown as Proposal[];
  }

  findOpenProposal(recordId: string, space: string): Proposal | undefined {
    const row = this.db
      .prepare("SELECT * FROM proposals WHERE record_id = ? AND space = ? AND state = 'proposed' LIMIT 1")
      .get(recordId, space);
    return row ? (row as unknown as Proposal) : undefined;
  }

  /** Session proposal volume (threat T1 alarm). */
  countProposalsSince(sinceIso: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM proposals WHERE created >= ?")
      .get(sinceIso);
    return Number(row?.n ?? 0);
  }
}

/** Sanitize a user query into FTS5 MATCH syntax: quoted terms, implicit AND, prefix on last term. */
export function ftsQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, ""))
    .filter(Boolean);
  if (terms.length === 0) return '""';
  return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(" ");
}

function toIndexed(row: Record<string, unknown>): IndexedRecord {
  return {
    id: String(row.id),
    source: String(row.source),
    title: String(row.title),
    type: String(row.type),
    project: String(row.project),
    status: String(row.status),
    author: String(row.author),
    tool: String(row.tool),
    created: String(row.created),
    updated: row.updated == null ? null : String(row.updated),
    tags: JSON.parse(String(row.tags ?? "[]")),
    paths: JSON.parse(String(row.paths ?? "[]")),
    review_after: row.review_after == null ? null : String(row.review_after),
    supersedes: row.supersedes == null ? null : String(row.supersedes),
    superseded_by: row.superseded_by == null ? null : String(row.superseded_by),
    body: String(row.body),
    content_hash: String(row.content_hash),
    file_path: String(row.file_path),
    redaction_dirty: Number(row.redaction_dirty ?? 0) === 1,
    rank: row.rank == null ? undefined : Number(row.rank),
  };
}
