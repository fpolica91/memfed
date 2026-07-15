import { describe, expect, it } from "vitest";
import { contentHash, parseRecord, RecordParseError, serializeRecord } from "../../src/core/record.js";
import type { MemoryRecord } from "../../src/core/types.js";

const BASE: MemoryRecord = {
  fm: {
    id: "01JZX5M8Q0V7T3E9RWN2K4YHBD",
    title: "Rotate refresh tokens on every exchange",
    type: "decision",
    project: "payments-api",
    tags: ["oauth", "auth"],
    paths: ["src/auth/**"],
    provenance: {
      author: "alice@corp.example",
      tool: "claude-code",
      created: "2026-07-15T00:00:00Z",
    },
    status: "active",
    schema_version: 1,
  },
  body: "We rotate refresh tokens on every exchange.\n\nReuse of a rotated token revokes the whole grant chain.",
};

describe("record canonical serialization", () => {
  it("round-trips byte-stable: serialize(parse(serialize(x))) === serialize(x)", () => {
    const once = serializeRecord(BASE);
    const twice = serializeRecord(parseRecord(once));
    expect(twice).toBe(once);
  });

  it("sorts and dedupes tags/paths, canonical key order", () => {
    const text = serializeRecord(BASE);
    expect(text).toContain("tags:\n  - auth\n  - oauth\n");
    expect(text.indexOf("id:")).toBeLessThan(text.indexOf("title:"));
    expect(text.indexOf("provenance:")).toBeLessThan(text.indexOf("status:"));
    expect(text.indexOf("status:")).toBeLessThan(text.indexOf("schema_version:"));
  });

  it("round-trips a record with all optional fields", () => {
    const full: MemoryRecord = {
      fm: {
        ...BASE.fm,
        updated: "2026-07-16T10:00:00Z",
        supersedes: "01JZX5M8Q0V7T3E9RWN2K4YHAA",
        superseded_by: "01JZX5M8Q0V7T3E9RWN2K4YHBB",
        relates_to: ["01JZX5M8Q0V7T3E9RWN2K4YHCC"],
        review_after: "2026-12-01",
        promoted_from: "platform/01JZX5M8Q0V7T3E9RWN2K4YHBD",
        promoted_by: "bob@corp.example",
      },
      body: BASE.body,
    };
    const once = serializeRecord(full);
    const roundTripped = parseRecord(once);
    expect(serializeRecord(roundTripped)).toBe(once);
    expect(roundTripped.fm.review_after).toBe("2026-12-01");
  });

  it("handles titles that need YAML quoting", () => {
    const tricky: MemoryRecord = {
      ...BASE,
      fm: { ...BASE.fm, title: "gotcha: staging DB resets nightly #ops [true]" },
    };
    const once = serializeRecord(tricky);
    const parsed = parseRecord(once);
    expect(parsed.fm.title).toBe("gotcha: staging DB resets nightly #ops [true]");
    expect(serializeRecord(parsed)).toBe(once);
  });

  it("preserves unicode bodies byte-stable", () => {
    const rec = { ...BASE, body: "naïve café — 日本語のメモ 🚀\n\ncode: `π = 3.14159`" };
    const once = serializeRecord(rec);
    expect(serializeRecord(parseRecord(once))).toBe(once);
  });

  it("normalizes CRLF and trailing whitespace", () => {
    const rec = { ...BASE, body: "line one\r\nline two\r\n\r\n\r\n" };
    const text = serializeRecord(rec);
    expect(text).not.toContain("\r");
    expect(text.endsWith("line two\n")).toBe(true);
  });

  it("ends with exactly one trailing newline and one blank line after frontmatter", () => {
    const text = serializeRecord(BASE);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).toContain("---\n\nWe rotate");
  });

  it("rejects missing frontmatter, bad ids, empty bodies, oversized bodies", () => {
    expect(() => parseRecord("no frontmatter")).toThrow(RecordParseError);
    expect(() => parseRecord("---\nid: nope\n---\n\nbody\n")).toThrow(RecordParseError);
    expect(() => serializeRecord({ ...BASE, body: "   " })).toThrow(/empty/);
    expect(() => serializeRecord({ ...BASE, body: "x".repeat(65 * 1024) })).toThrow(/exceeds/);
  });

  it("rejects unknown record types and statuses", () => {
    const text = serializeRecord(BASE)
      .replace("type: decision", "type: banana")
      .replace("status: active", "status: banana");
    expect(() => parseRecord(text)).toThrow(RecordParseError);
  });

  it("content hash is stable across metadata-only changes", () => {
    const a = contentHash(BASE);
    const b = contentHash({ ...BASE, fm: { ...BASE.fm, tags: ["different"], status: "deprecated" } });
    const c = contentHash({ ...BASE, body: `${BASE.body} changed` });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
