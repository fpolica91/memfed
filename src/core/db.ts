/**
 * SQLite driver seam (RFC §5): node:sqlite on Node >=22.13, bun:sqlite under Bun.
 * The index is a disposable cache, so driver differences must never leak upward.
 */

export type SqlValue = string | number | bigint | null;

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Stmt {
  run(...params: SqlValue[]): RunResult;
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
}

export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
}

export interface OpenDbOptions {
  /** Open strictly read-only (importers reading foreign databases). */
  readOnly?: boolean;
}

export async function openDb(file: string, opts: OpenDbOptions = {}): Promise<Db> {
  if (process.versions.bun) return openBunDb(file, opts);
  return openNodeDb(file, opts);
}

async function openNodeDb(file: string, opts: OpenDbOptions): Promise<Db> {
  const { DatabaseSync } = await import("node:sqlite");
  if (opts.readOnly) {
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 3000");
    return wrapNode(db);
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  return wrapNode(db);
}

function wrapNode(db: {
  prepare(sql: string): {
    run(...p: SqlValue[]): unknown;
    get(...p: SqlValue[]): unknown;
    all(...p: SqlValue[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}): Db {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run: (...p) => stmt.run(...p) as RunResult,
        get: (...p) => stmt.get(...p) as Record<string, unknown> | undefined,
        all: (...p) => stmt.all(...p) as Record<string, unknown>[],
      };
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

async function openBunDb(file: string, opts: OpenDbOptions): Promise<Db> {
  const specifier = "bun:sqlite";
  const mod = (await import(specifier)) as {
    Database: new (
      file: string,
      options?: { readonly?: boolean },
    ) => {
      query(sql: string): {
        run(...p: SqlValue[]): { changes: number; lastInsertRowid: number };
        get(...p: SqlValue[]): Record<string, unknown> | null;
        all(...p: SqlValue[]): Record<string, unknown>[];
      };
      exec(sql: string): void;
      close(): void;
    };
  };
  const db = new mod.Database(file, opts.readOnly ? { readonly: true } : undefined);
  if (!opts.readOnly) db.exec("PRAGMA journal_mode = WAL");
  return {
    prepare(sql) {
      const stmt = db.query(sql);
      return {
        run: (...p) => stmt.run(...p),
        get: (...p) => stmt.get(...p) ?? undefined,
        all: (...p) => stmt.all(...p),
      };
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

/**
 * Suppress node:sqlite's ExperimentalWarning on stderr (stdout carries MCP protocol;
 * stderr hygiene only). Installed once from the CLI entry before the first openDb.
 */
export function suppressSqliteExperimentalWarning(): void {
  const original = process.emitWarning.bind(process);
  // biome-ignore lint/suspicious/noExplicitAny: emitWarning has many overloads
  (process as any).emitWarning = (warning: any, ...args: any[]) => {
    const type =
      typeof args[0] === "string" ? args[0] : (args[0]?.type ?? (warning as Error)?.name);
    const message = typeof warning === "string" ? warning : ((warning as Error)?.message ?? "");
    if (type === "ExperimentalWarning" && /sqlite/i.test(message)) return;
    original(warning, ...args);
  };
}
