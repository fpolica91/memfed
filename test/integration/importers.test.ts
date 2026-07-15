import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureInit, getPaths, loadConfig, type Paths } from "../../src/core/config.js";
import { openDb } from "../../src/core/db.js";
import { IndexDb } from "../../src/core/index-db.js";
import { Store } from "../../src/core/store.js";
import { importClaudeMem } from "../../src/importers/claude-mem.js";
import { importClaudeNative } from "../../src/importers/claude-native.js";

let root: string;
let paths: Paths;
let index: IndexDb;
let store: Store;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "memfed-import-"));
  paths = ensureInit(getPaths(join(root, "home")));
  index = await IndexDb.open(paths.indexPath);
  store = new Store(paths, index, loadConfig(paths));
});

afterEach(() => {
  index.close();
  rmSync(root, { recursive: true, force: true });
});

/** Minimal claude-mem schema fixture (columns the importer reads). */
async function buildClaudeMemFixture(file: string): Promise<void> {
  const db = await openDb(file);
  db.exec(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY, project TEXT, merged_into_project TEXT,
    title TEXT, subtitle TEXT, text TEXT, narrative TEXT, facts TEXT, concepts TEXT,
    type TEXT, created_at_epoch INTEGER)`);
  const ins = db.prepare(
    "INSERT INTO observations (project, merged_into_project, title, subtitle, text, narrative, facts, concepts, type, created_at_epoch) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  // 1784073600 = 2026-07-15T00:00:00Z
  ins.run(
    "Harness",
    null,
    "Use ULIDs for run ids",
    "sortable ids",
    "ULIDs everywhere.",
    "We standardized on ULIDs for run identifiers.",
    '["ULIDs sort by time"]',
    '["ids"]',
    "decision",
    1784073600,
  );
  ins.run(
    "harness",
    "harness",
    "Fix flaky retry test",
    null,
    "Retry test raced the clock.",
    null,
    null,
    null,
    "bugfix",
    1784073700,
  );
  ins.run(
    "other-proj",
    null,
    "Explored the scheduler",
    null,
    "Notes about scheduler internals.",
    null,
    null,
    null,
    "discovery",
    1784073800,
  );
  db.close();
}

describe("claude-mem importer", () => {
  it("imports decisions by default as private candidates with mapped projects", async () => {
    const fixture = join(root, "claude-mem.db");
    await buildClaudeMemFixture(fixture);

    const result = await importClaudeMem(store, {
      dbPath: fixture,
      map: { Harness: "harness" },
    });
    expect(result).toMatchObject({ imported: 1, total: 1 });

    const rows = index.search({ status: "candidate" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Use ULIDs for run ids");
    expect(rows[0]!.project).toBe("harness");
    expect(rows[0]!.type).toBe("decision");
    expect(rows[0]!.tags).toContain("cm:decision");
    expect(rows[0]!.tool).toBe("import:claude-mem");
    expect(rows[0]!.created).toBe("2026-07-15T00:00:00Z");
  });

  it("--types all maps bugfix->gotcha, discovery->reference; re-import dedupes", async () => {
    const fixture = join(root, "claude-mem.db");
    await buildClaudeMemFixture(fixture);

    const first = await importClaudeMem(store, { dbPath: fixture, types: ["all"] });
    expect(first.imported).toBe(3);
    const gotcha = index.search({ type: "gotcha", status: "candidate" });
    expect(gotcha[0]!.title).toBe("Fix flaky retry test");
    const refs = index.search({ type: "reference", status: "candidate" });
    expect(refs).toHaveLength(1);

    const second = await importClaudeMem(store, { dbPath: fixture, types: ["all"] });
    expect(second.imported).toBe(0);
    expect(second.skippedDuplicates).toBe(3);
  });

  it("never modifies the source database (read-only guarantee)", async () => {
    const fixture = join(root, "claude-mem.db");
    await buildClaudeMemFixture(fixture);
    const { createHash } = await import("node:crypto");
    const { readFileSync } = await import("node:fs");
    const before = createHash("sha256").update(readFileSync(fixture)).digest("hex");
    await importClaudeMem(store, { dbPath: fixture, types: ["all"] });
    const after = createHash("sha256").update(readFileSync(fixture)).digest("hex");
    expect(after).toBe(before);
  });
});

describe("claude-native importer", () => {
  it("imports frontmatter memory files as candidates, skipping MEMORY.md", () => {
    const projects = join(root, "claude-projects");
    const memDir = join(projects, "-home-alice-payments", "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "MEMORY.md"), "- [index](x.md)\n");
    writeFileSync(
      join(memDir, "staging-db.md"),
      `---\nname: staging-db-resets\ndescription: Staging DB resets nightly at 03:00 UTC\nmetadata:\n  type: project\n---\n\nThe staging database is wiped nightly; never store fixtures there.\n`,
    );

    const result = importClaudeNative(store, {
      dir: projects,
      map: { "-home-alice-payments": "payments-api" },
    });
    expect(result).toMatchObject({ imported: 1, total: 1 });
    const rows = index.search({ status: "candidate" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.project).toBe("payments-api");
    expect(rows[0]!.title).toBe("staging db resets");
    expect(rows[0]!.body).toContain("wiped nightly");
  });
});
