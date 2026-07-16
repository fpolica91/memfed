import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type Config, loadState, type Paths, saveConfig, saveState } from "../core/config.js";
import type { IndexDb } from "../core/index-db.js";
import { parseRecord } from "../core/record.js";
import {
  formatZodError,
  type SpaceManifest,
  SpaceManifestSchema,
  SUBDIR_RE,
} from "../core/types.js";
import { git, revParse } from "./exec.js";

export interface Space {
  name: string;
  url: string;
  /** The git repo clone. */
  dir: string;
  /** In-repo mode (RFC §6.3): subdirectory holding the space content; "" = dedicated repo. */
  root: string;
  manifest: SpaceManifest;
}

export const MANIFEST_PATH = ".memfed/space.yaml";

export function spaceDir(paths: Paths, name: string): string {
  return join(paths.spacesDir, name);
}

/** Absolute directory of the space CONTENT (repo root, or the in-repo subdir). */
export function contentDir(space: Space): string {
  return space.root ? join(space.dir, space.root) : space.dir;
}

/** Repo-relative prefix of the records directory, with trailing slash (for git paths). */
export function recordsPrefix(space: Space): string {
  return space.root ? `${space.root}/records/` : "records/";
}

/** Repo-relative path of one record file (for git add/show/update-index). */
export function recordRelPath(space: Space, id: string): string {
  return `${recordsPrefix(space)}${id}.md`;
}

/** Repo-relative prefix of the presence directory, with trailing slash. */
export function presencePrefix(space: Space): string {
  return space.root ? `${space.root}/presence/` : "presence/";
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
  const root = entry.root ?? "";
  const manifest = readManifest(root ? join(dir, root) : dir);
  return { name, url: entry.url, dir, root, manifest };
}

export interface InitSpaceInput {
  url: string;
  name: string;
  kind?: "project" | "team" | "org";
  policy?: "direct" | "pr";
  description?: string;
  /** In-repo mode: create the space at this subdirectory of an EXISTING repo. */
  root?: string;
}

function writeSpaceLayout(target: string, manifest: SpaceManifest): void {
  mkdirSync(join(target, ".memfed"), { recursive: true });
  mkdirSync(join(target, "records"), { recursive: true });
  writeFileSync(join(target, MANIFEST_PATH), stringifyYaml(manifest, { lineWidth: 0 }));
  writeFileSync(
    join(target, ".memfed", "lint-allow"),
    "# ruleId:fingerprint entries accepted by reviewers\n",
  );
  writeFileSync(join(target, "records", ".gitkeep"), "");
}

const LINT_WORKFLOW = `name: memfed-lint
on: [push, pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx --yes memfed lint-space
`;

/** Create a space and push its layout: a fresh dedicated repo, or in-repo at --root (RFC §6). */
export function initSpace(paths: Paths, config: Config, input: InitSpaceInput): Space {
  if (config.spaces[input.name]) throw new Error(`space '${input.name}' already exists in config`);
  if (input.root && !SUBDIR_RE.test(input.root))
    throw new Error(`--root must be a relative subdirectory (got '${input.root}')`);
  const dir = spaceDir(paths, input.name);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);

  const root = input.root ?? "";
  const manifest: SpaceManifest = SpaceManifestSchema.parse({
    name: input.name,
    kind: input.kind ?? "team",
    description: input.description,
    publish: input.policy ?? (input.kind === "org" ? "pr" : "direct"),
    ...(root ? { root } : {}),
  });

  if (root) {
    // In-repo: the host repo already exists (and may be empty). We only ever
    // touch the subtree at `root` — the host repo's own files are sacred.
    git(["clone", "-q", input.url, dir], { check: false });
    if (!existsSync(join(dir, ".git"))) throw new Error(`could not clone ${input.url}`);
    const target = join(dir, root);
    if (existsSync(join(target, MANIFEST_PATH)))
      throw new Error(`${input.url} already has a memfed space at '${root}'`);
    const hadCommits = revParse(dir, "HEAD") !== undefined;
    writeSpaceLayout(target, manifest);
    git(["add", root], { cwd: dir });
    git(["commit", "-q", "-m", `memfed: initialize in-repo space '${input.name}' at ${root}/`], {
      cwd: dir,
    });
    if (!hadCommits) git(["branch", "-M", "main"], { cwd: dir, check: false });
    git(["push", "-q", "-u", "origin", "main"], { cwd: dir });
    // Keep the managed clone lean: only the space subtree stays checked out.
    git(["sparse-checkout", "set", root], { cwd: dir, check: false });
  } else {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeSpaceLayout(dir, manifest);
    // CI backstop (RFC §3): re-scan every record server-side on push/PR.
    writeFileSync(join(dir, ".github", "workflows", "memfed-lint.yml"), LINT_WORKFLOW);
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
      { cwd: dir },
    );
    git(["remote", "add", "origin", input.url], { cwd: dir });
    git(["push", "-q", "-u", "origin", "main"], { cwd: dir });
  }

  config.spaces[input.name] = { url: input.url, ...(root ? { root } : {}) };
  saveConfig(config, paths);
  pinSpace(paths, input.name, revParse(dir, "main"));

  return { name: input.name, url: input.url, dir, root, manifest };
}

/** Find in-repo space roots by scanning the tree for .memfed/space.yaml manifests. */
function discoverRoots(dir: string): string[] {
  const out = git(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: dir, check: false });
  if (out.code !== 0) return [];
  return out.stdout
    .split("\n")
    .filter((f) => f.endsWith(MANIFEST_PATH))
    .map((f) => (f === MANIFEST_PATH ? "" : dirname(dirname(f))));
}

/** Join an existing space by cloning it; auto-discovers an in-repo root when needed. */
export function addSpace(
  paths: Paths,
  config: Config,
  url: string,
  name?: string,
  rootOpt?: string,
): Space {
  const tmpName = name ?? `.pending-${Date.now()}`;
  const dir = spaceDir(paths, tmpName);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  git(["clone", "-q", url, dir]);

  let root = rootOpt ?? "";
  if (!rootOpt && !existsSync(join(dir, MANIFEST_PATH))) {
    const roots = discoverRoots(dir);
    if (roots.length === 1 && roots[0]) root = roots[0];
    else if (roots.length > 1)
      throw new Error(
        `${url} contains multiple memfed spaces (${roots.join(", ")}) — pass --root to pick one`,
      );
  }
  if (root && !SUBDIR_RE.test(root))
    throw new Error(`--root must be a relative subdirectory (got '${root}')`);

  const manifest = readManifest(root ? join(dir, root) : dir);
  if (root && manifest.root && manifest.root !== root)
    console.error(`warning: manifest declares root '${manifest.root}' but joined at '${root}'`);
  if (root) git(["sparse-checkout", "set", root], { cwd: dir, check: false });

  const finalName = name ?? manifest.name;
  if (config.spaces[finalName]) throw new Error(`space '${finalName}' already exists in config`);
  let finalDir = dir;
  if (finalName !== tmpName) {
    finalDir = spaceDir(paths, finalName);
    if (existsSync(finalDir)) throw new Error(`${finalDir} already exists`);
    renameSync(dir, finalDir);
  }
  config.spaces[finalName] = { url, ...(root ? { root } : {}) };
  saveConfig(config, paths);
  pinSpace(paths, finalName, revParse(finalDir, "origin/main") ?? revParse(finalDir, "main"));
  return { name: finalName, url, dir: finalDir, root, manifest };
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
  const recordsDir = join(contentDir(space), "records");
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
