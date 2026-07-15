import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { formatZodError, ProjectMarkerSchema } from "./types.js";

export interface ResolvedProject {
  slug: string;
  dir: string;
  spaces: string[];
}

/** Walk up from startDir looking for a .memfed.yaml project marker. */
export function findProjectMarker(startDir: string): ResolvedProject | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const file = join(dir, ".memfed.yaml");
    if (existsSync(file)) {
      const raw = parseYaml(readFileSync(file, "utf8"));
      const parsed = ProjectMarkerSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`${file}: ${formatZodError(parsed.error)}`);
      return { slug: parsed.data.project, dir, spaces: parsed.data.spaces ?? [] };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
