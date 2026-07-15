import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureInit, getPaths, loadConfig, type Paths } from "../../src/core/config.js";
import { IndexDb, LOCAL_SOURCE } from "../../src/core/index-db.js";
import { Store } from "../../src/core/store.js";

let home: string;
let paths: Paths;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "memfed-test-"));
  paths = ensureInit(getPaths(home));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function openStore(): Promise<{ store: Store; index: IndexDb }> {
  const index = await IndexDb.open(paths.indexPath);
  const store = new Store(paths, index, loadConfig(paths));
  return { store, index };
}

describe("store + index e2e (tmp MEMFED_HOME)", () => {
  it("adds three records, ranks oauth search correctly, reindex is identical", async () => {
    const { store, index } = await openStore();
    const a = store.create({
      title: "Rotate refresh tokens on every exchange",
      type: "decision",
      project: "payments-api",
      tags: ["oauth", "auth"],
      body: "OAuth refresh token rotation is mandatory. Reuse revokes the grant chain.",
    });
    store.create({
      title: "Service names use kebab-case",
      type: "convention",
      project: "payments-api",
      body: "All deployables are kebab-case in CI and compose files.",
    });
    store.create({
      title: "Staging database resets nightly",
      type: "gotcha",
      project: "payments-api",
      body: "The staging database is wiped at 03:00 UTC; do not store test fixtures there.",
    });

    const hits = index.search({ query: "oauth refresh rotation" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe(a.record.fm.id);
    expect(hits[0]!.source).toBe(LOCAL_SOURCE);

    const before = index.search({ limit: 100 }).map((r) => `${r.id}:${r.content_hash}`);
    index.close();

    // Files are the truth: delete the index, rebuild, get identical results.
    unlinkSync(paths.indexPath);
    const { store: store2, index: index2 } = await openStore();
    const { count, errors } = store2.reindexLocal();
    expect(errors).toEqual([]);
    expect(count).toBe(3);
    const after = index2.search({ limit: 100 }).map((r) => `${r.id}:${r.content_hash}`);
    expect(after.sort()).toEqual(before.sort());
    const hits2 = index2.search({ query: "oauth refresh rotation" });
    expect(hits2[0]!.id).toBe(a.record.fm.id);
    index2.close();
  });

  it("capture-time redaction tags dirty records (never suggested, still stored)", async () => {
    const { store, index } = await openStore();
    const { record, dirty } = store.create({
      title: "How I connect to prod",
      type: "runbook",
      project: "payments-api",
      body: "Use postgres://admin:hunter22@db.internal:5432/prod for the primary.",
    });
    expect(dirty).toBe(true);
    const row = index.getById(record.fm.id);
    expect(row?.redaction_dirty).toBe(true);
    expect(existsSync(store.recordPath(record.fm.id))).toBe(true);
    index.close();
  });

  it("record files on disk are canonical and parseable", async () => {
    const { store, index } = await openStore();
    const { record } = store.create({
      project: "demo",
      type: "reference",
      body: "# Derived title from heading\n\nBody continues here.",
    });
    expect(record.fm.title).toBe("Derived title from heading");
    const text = readFileSync(store.recordPath(record.fm.id), "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    index.close();
  });

  it("filters: type, project, tag", async () => {
    const { store, index } = await openStore();
    store.create({ project: "alpha", type: "decision", body: "Alpha decided X.", tags: ["infra"] });
    store.create({ project: "beta", type: "gotcha", body: "Beta gotcha Y.", tags: ["infra", "ci"] });
    expect(index.search({ project: "alpha" })).toHaveLength(1);
    expect(index.search({ type: "gotcha" })).toHaveLength(1);
    expect(index.search({ tag: "infra" })).toHaveLength(2);
    expect(index.search({ tag: "ci" })).toHaveLength(1);
    index.close();
  });
});

describe("CLI smoke (spawned via tsx)", () => {
  const cliEnv = () => ({ ...process.env, MEMFED_HOME: home, NO_COLOR: "1" });
  const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
  const cli = (args: string[], input?: string) =>
    execFileSync(tsx, ["src/cli/index.ts", ...args], {
      encoding: "utf8",
      env: cliEnv(),
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });

  it("init → add → search → show round-trip through the real CLI", () => {
    expect(cli(["init"])).toContain("initialized memfed");
    const out = cli(
      ["add", "--project", "payments-api", "--type", "decision", "--title", "Use ULIDs for record ids", "--body-file", "-"],
      "ULIDs sort by time and avoid coordination.\n",
    );
    expect(out).toContain("created");
    const searchOut = cli(["search", "ulids"]);
    expect(searchOut).toContain("Use ULIDs for record ids");
    const id = out.match(/created (\S+)/)?.[1] as string;
    const showOut = cli(["show", id.slice(0, 8)]);
    expect(showOut).toContain("Use ULIDs for record ids");
    expect(showOut).toContain("ULIDs sort by time");
  });

  it("uninitialized home fails with guidance", () => {
    const fresh = mkdtempSync(join(tmpdir(), "memfed-empty-"));
    try {
      execFileSync(tsx, ["src/cli/index.ts", "list"], {
        encoding: "utf8",
        env: { ...process.env, MEMFED_HOME: fresh, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect.unreachable("list on an uninitialized home should fail");
    } catch (e) {
      expect(String((e as { stderr?: unknown }).stderr ?? e)).toContain("memfed init");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
