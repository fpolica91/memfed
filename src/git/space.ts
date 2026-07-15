import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type Config, loadState, type Paths, saveConfig, saveState } from "../core/config.js";
import type { IndexDb } from "../core/index-db.js";
import { parseRecord } from "../core/record.js";
import { formatZodError, type SpaceManifest, SpaceManifestSchema } from "../core/types.js";
import { git, revParse } from "./exec.js";

export interface Space {
  name: string;
  url: string;
  dir: string;
  manifest: SpaceManifest;
}

export const MANIFEST_PATH = ".memfed/space.yaml";

export function spaceDir(paths: Paths, name: string): string {
  return join(paths.spacesDir, name);
}

export function readManifest(dir: string): SpaceManifest {
  const file = join(dir, MANIFEST_PATH);
  if (!existsSync(file)) throw new Error(`${dir} is not a memfed space (missing ${MANIFEST_PATH})`);
  const parsed = SpaceManifestSchema.safeParse(parseYaml(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}: ${formatZodError(parsed.error)}`);
  return parsed.data;
}

export function loadSpace(paths: Paths, config: Config, name: string): Space {
  const entry = config.spaces[name];
  if (!entry)
    throw new Error(
      `unknown space '${name}' (known: ${Object.keys(config.spaces).join(", ") || "none"})`,
    );
  const dir = spaceDir(paths, name);
  if (!existsSync(dir))
    throw new Error(`space '${name}' has no local clone — run 'memfed sync ${name}'`);
  return { name, url: entry.url, dir, manifest: readManifest(dir) };
}

export interface InitSpaceInput {
  url: string;
  name: string;
  kind?: "project" | "team" | "org";
  policy?: "direct" | "pr";
  description?: string;
}

/** Create a brand-new space repo and push its initial layout (RFC §6). */
export function initSpace(paths: Paths, config: Config, input: InitSpaceInput): Space {
  if (config.spaces[input.name]) throw new Error(`space '${input.name}' already exists in config`);
  const dir = spaceDir(paths, input.name);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);

  const manifest: SpaceManifest = SpaceManifestSchema.parse({
    name: input.name,
    kind: input.kind ?? "team",
    description: input.description,
    publish: input.policy ?? (input.kind === "org" ? "pr" : "direct"),
  });

  mkdirSync(join(dir, ".memfed"), { recursive: true });
  mkdirSync(join(dir, "records"), { recursive: true });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, MANIFEST_PATH), stringifyYaml(manifest, { lineWidth: 0 }));
  writeFileSync(
    join(dir, ".memfed", "lint-allow"),
    "# ruleId:fingerprint entries accepted by reviewers\n",
  );
  writeFileSync(join(dir, "records", ".gitkeep"), "");
  // CI backstop (RFC §3): re-scan every record server-side on push/PR.
  writeFileSync(
    join(dir, ".github", "workflows", "memfed-lint.yml"),
    `name: memfed-lint
on: [push, pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx --yes memfed lint-space
`,
  );
  writeFileSync(
    join(dir, "README.md"),
    `# ${input.name} — memfed space\n\nShared memory records for AI coding assistants.\nManaged by [memfed]; records live in \`records/\`, one fact per file.\nReadership of this repo = readership of these records.\n`,
  );

  git(["init", "-b", "main"], { cwd: dir });
  git(["add", "-A"], { cwd: dir });
  git(
    [
      "commit",
      "-q",
      "-m",
      `memfed: initialize space '${input.name}' (${manifest.kind}, publish=${manifest.publish})`,
    ],
    {
      cwd: dir,
    },
  );
  git(["remote", "add", "origin", input.url], { cwd: dir });
  git(["push", "-q", "-u", "origin", "main"], { cwd: dir });

  config.spaces[input.name] = { url: input.url };
  saveConfig(config, paths);
  pinSpace(paths, input.name, revParse(dir, "main"));

  return { name: input.name, url: input.url, dir, manifest };
}

/** Join an existing space by cloning it. */
export function addSpace(paths: Paths, config: Config, url: string, name?: string): Space {
  const tmpName = name ?? `.pending-${Date.now()}`;
  const dir = spaceDir(paths, tmpName);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  git(["clone", "-q", url, dir]);
  const manifest = readManifest(dir);
  const finalName = name ?? manifest.name;
  if (config.spaces[finalName]) throw new Error(`space '${finalName}' already exists in config`);
  let finalDir = dir;
  if (finalName !== tmpName) {
    finalDir = spaceDir(paths, finalName);
    if (existsSync(finalDir)) throw new Error(`${finalDir} already exists`);
    renameSync(dir, finalDir);
  }
  config.spaces[finalName] = { url };
  saveConfig(config, paths);
  pinSpace(paths, finalName, revParse(finalDir, "origin/main") ?? revParse(finalDir, "main"));
  return { name: finalName, url, dir: finalDir, manifest };
}

export function pinSpace(paths: Paths, name: string, sha: string | undefined): void {
  if (!sha) return;
  const state = loadState(paths);
  state.pins[name] = sha;
  saveState(state, paths);
}

export function getPin(paths: Paths, name: string): string | undefined {
  return loadState(paths).pins[name];
}

/** Meta key tracking which commit a space's index slice reflects. */
export function indexedShaKey(name: string): string {
  return `indexed_sha:${name}`;
}

/** Full rebuild of one space's slice of the index from its records/ directory. */
export function reindexSpace(
  index: IndexDb,
  space: Space,
): { count: number; errors: Array<{ file: string; error: string }> } {
  index.clearSource(space.name);
  const recordsDir = join(space.dir, "records");
  let count = 0;
  const errors: Array<{ file: string; error: string }> = [];
  if (existsSync(recordsDir)) {
    for (const f of readdirSync(recordsDir)) {
      if (!f.endsWith(".md")) continue;
      const file = join(recordsDir, f);
      try {
        const record = parseRecord(readFileSync(file, "utf8"), file);
        index.upsertRecord(space.name, record, file);
        count++;
      } catch (e) {
        errors.push({ file, error: (e as Error).message });
      }
    }
  }
  const head = revParse(space.dir, "HEAD");
  if (head) index.setMeta(indexedShaKey(space.name), head);
  return { count, errors };
}
