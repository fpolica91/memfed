import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDirty } from "../redact/scan.js";
import { appendAudit } from "./audit.js";
import { type Config, type Paths, resolveAuthor } from "./config.js";
import { newId } from "./ids.js";
import { type IndexDb, LOCAL_SOURCE } from "./index-db.js";
import { parseRecord, recordFileName, serializeRecord } from "./record.js";
import {
  type MemoryRecord,
  nowIso,
  type Provenance,
  type RecordStatus,
  type RecordType,
} from "./types.js";

export interface CreateRecordInput {
  title?: string;
  type?: RecordType;
  project: string;
  body: string;
  tags?: string[];
  paths?: string[];
  tool?: string;
  status?: RecordStatus;
  /** Importer override — keeps original author/tool/created. */
  provenance?: Provenance;
}

export function deriveTitle(body: string): string {
  const first = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const stripped = (first ?? "untitled").replace(/^#+\s*/, "").replace(/[*_`]/g, "");
  return stripped.length > 120 ? `${stripped.slice(0, 117)}...` : stripped;
}

/** Private-store CRUD (RFC §5). All writes land here; nothing leaves without the publish pipeline. */
export class Store {
  constructor(
    readonly paths: Paths,
    readonly index: IndexDb,
    readonly config: Config,
  ) {}

  recordPath(id: string): string {
    return join(this.paths.recordsDir, recordFileName(id));
  }

  exists(id: string): boolean {
    return existsSync(this.recordPath(id));
  }

  create(input: CreateRecordInput): { record: MemoryRecord; dirty: boolean } {
    const id = newId();
    const record: MemoryRecord = {
      fm: {
        id,
        title: input.title?.trim() || deriveTitle(input.body),
        type: input.type ?? "reference",
        project: input.project,
        tags: input.tags,
        paths: input.paths,
        provenance: input.provenance ?? {
          author: resolveAuthor(this.config),
          tool: input.tool ?? "manual",
          created: nowIso(),
        },
        status: input.status ?? "active",
        schema_version: 1,
      },
      body: input.body,
    };
    const text = serializeRecord(record);
    const normalized = parseRecord(text); // guarantees canonical form + validation
    writeFileSync(this.recordPath(id), text, { mode: 0o600 });
    const dirty = isDirty(`${normalized.fm.title}\n${normalized.body}`);
    this.index.upsertRecord(LOCAL_SOURCE, normalized, this.recordPath(id), dirty);
    appendAudit(
      {
        action: "add",
        record_id: id,
        details: { project: input.project, type: normalized.fm.type },
      },
      this.paths.auditPath,
    );
    return { record: normalized, dirty };
  }

  /** Read a private record from disk (source of truth). */
  get(id: string): MemoryRecord {
    const path = this.recordPath(id);
    if (!existsSync(path)) throw new Error(`no private record ${id}`);
    return parseRecord(readFileSync(path, "utf8"), path);
  }

  /** True if this record exists in any space cache (published somewhere). */
  isPublished(id: string): boolean {
    return this.index.sourcesForId(id).some((s) => s !== LOCAL_SOURCE);
  }

  /** Overwrite a private record with new content (bodies of published records are immutable). */
  write(record: MemoryRecord, opts: { audit?: boolean } = {}): MemoryRecord {
    const text = serializeRecord(record);
    const normalized = parseRecord(text);
    const path = this.recordPath(record.fm.id);
    writeFileSync(path, text, { mode: 0o600 });
    const dirty = isDirty(`${normalized.fm.title}\n${normalized.body}`);
    this.index.upsertRecord(LOCAL_SOURCE, normalized, path, dirty);
    if (opts.audit !== false)
      appendAudit({ action: "edit", record_id: record.fm.id }, this.paths.auditPath);
    return normalized;
  }

  listIds(): string[] {
    if (!existsSync(this.paths.recordsDir)) return [];
    return readdirSync(this.paths.recordsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
  }

  /** Rebuild the local slice of the index from files (RFC §5: files are the truth). */
  reindexLocal(): { count: number; errors: Array<{ file: string; error: string }> } {
    this.index.clearSource(LOCAL_SOURCE);
    let count = 0;
    const errors: Array<{ file: string; error: string }> = [];
    for (const id of this.listIds()) {
      const path = this.recordPath(id);
      try {
        const record = parseRecord(readFileSync(path, "utf8"), path);
        if (record.fm.id !== id)
          throw new Error(`filename/id mismatch (file ${id}, frontmatter ${record.fm.id})`);
        const dirty = isDirty(`${record.fm.title}\n${record.body}`);
        this.index.upsertRecord(LOCAL_SOURCE, record, path, dirty);
        count++;
      } catch (e) {
        errors.push({ file: path, error: (e as Error).message });
      }
    }
    return { count, errors };
  }
}
