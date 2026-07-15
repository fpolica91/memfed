import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveAuthor } from "../core/config.js";
import { contentHash } from "../core/record.js";
import type { Store } from "../core/store.js";
import type { RecordType } from "../core/types.js";
import type { ImportResult } from "./claude-mem.js";

/**
 * Claude Code native memory importer (RFC §13.2): one fact per file with YAML
 * frontmatter under ~/.claude/projects/<slug>/memory/. MEMORY.md index files
 * are skipped. Imports land PRIVATE with status: candidate.
 */

export const CLAUDE_NATIVE_DEFAULT_DIR = join(homedir(), ".claude", "projects");

const TYPE_MAP: Record<string, RecordType> = {
  user: "preference",
  feedback: "convention",
  project: "reference",
  reference: "reference",
};

export interface ClaudeNativeImportOptions {
  dir?: string;
  /** project-dir slug -> project slug renames. */
  map?: Record<string, string>;
}

function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return slug || "unknown";
}

export function importClaudeNative(
  store: Store,
  opts: ClaudeNativeImportOptions = {},
): ImportResult {
  const base = opts.dir ?? CLAUDE_NATIVE_DEFAULT_DIR;
  if (!existsSync(base)) throw new Error(`no Claude Code projects directory at ${base}`);
  const result: ImportResult = { imported: 0, skippedDuplicates: 0, skippedInvalid: 0, total: 0 };
  const author = resolveAuthor(store.config);

  for (const projectDir of readdirSync(base)) {
    const memoryDir = join(base, projectDir, "memory");
    if (!existsSync(memoryDir)) continue;
    const project = opts.map?.[projectDir] ?? slugify(projectDir.replace(/^-+/, ""));
    for (const file of readdirSync(memoryDir)) {
      if (!file.endsWith(".md") || file === "MEMORY.md") continue;
      result.total++;
      const path = join(memoryDir, file);
      try {
        const text = readFileSync(path, "utf8");
        const fmMatch = /^---\n([\s\S]*?)\n---\n?/.exec(text);
        const fm = fmMatch ? (parseYaml(fmMatch[1] ?? "") ?? {}) : {};
        const body = (fmMatch ? text.slice(fmMatch[0].length) : text).trim();
        const description = typeof fm.description === "string" ? fm.description : undefined;
        const fullBody = body || description;
        if (!fullBody) {
          result.skippedInvalid++;
          continue;
        }
        const title =
          (typeof fm.name === "string" && fm.name.replace(/-/g, " ")) || description?.slice(0, 120);
        const nativeType = fm.metadata?.type as string | undefined;
        const type = TYPE_MAP[nativeType ?? "reference"] ?? "reference";

        const probe = {
          fm: {
            id: "01AAAAAAAAAAAAAAAAAAAAAAAA",
            title: title || fullBody.slice(0, 120),
            type,
            project,
            provenance: { author, tool: "import:claude-native", created: "2000-01-01T00:00:00Z" },
            status: "candidate" as const,
            schema_version: 1 as const,
          },
          body: fullBody,
        };
        if (store.index.findByContentHash(contentHash(probe)).length > 0) {
          result.skippedDuplicates++;
          continue;
        }
        store.create({
          title,
          type,
          project,
          body: fullBody,
          tags: [`cn:${nativeType ?? "unknown"}`],
          status: "candidate",
          tool: "import:claude-native",
        });
        result.imported++;
      } catch {
        result.skippedInvalid++;
      }
    }
  }
  return result;
}
