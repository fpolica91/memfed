import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface SpaceEntry {
  url: string;
  /** In-repo mode: space content lives at this subdirectory of the host repo. */
  root?: string;
}

export interface ProjectEntry {
  dir: string;
  spaces: string[];
  /** Also render a managed block into CLAUDE.md (default: AGENTS.md only). */
  claudeMd?: boolean;
}

export interface Config {
  version: 1;
  /** Provenance author override; defaults to git config user.email. */
  author?: string;
  spaces: Record<string, SpaceEntry>;
  projects: Record<string, ProjectEntry>;
  importMaps?: { claudeMem?: Record<string, string> };
}

export interface PresenceState {
  mode: "on" | "off" | "auto";
  lastPush?: string;
  /** The standing consent's exact content — re-pushed on auto refresh. */
  note?: string;
  areas?: string[];
  project?: string;
  ttlHours?: number;
}

/** Machine state, kept out of the user-editable config (atomic writes). */
export interface State {
  /** TOFU pins: space name -> last-seen origin/main commit (RFC §8). */
  pins: Record<string, string>;
  presence: Record<string, PresenceState>;
  /** Local kill-switch (RFC §16 T2): record ids excluded from briefs/projections/search. */
  quarantined?: string[];
}

export interface Paths {
  home: string;
  storeDir: string;
  recordsDir: string;
  indexPath: string;
  configPath: string;
  statePath: string;
  auditPath: string;
  spacesDir: string;
}

export function memfedHome(): string {
  return process.env.MEMFED_HOME ?? join(homedir(), ".memfed");
}

export function getPaths(home = memfedHome()): Paths {
  return {
    home,
    storeDir: join(home, "store"),
    recordsDir: join(home, "store", "records"),
    indexPath: join(home, "index.sqlite"),
    configPath: join(home, "config.yaml"),
    statePath: join(home, "state.json"),
    auditPath: join(home, "audit.jsonl"),
    spacesDir: join(home, "spaces"),
  };
}

export function isInitialized(paths = getPaths()): boolean {
  return existsSync(paths.configPath);
}

const DEFAULT_CONFIG: Config = { version: 1, spaces: {}, projects: {} };

export function ensureInit(paths = getPaths()): Paths {
  for (const dir of [paths.home, paths.storeDir, paths.recordsDir, paths.spacesDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(paths.home, 0o700);
  } catch {
    /* best effort on non-POSIX */
  }
  if (!existsSync(paths.configPath)) saveConfig(DEFAULT_CONFIG, paths);
  if (!existsSync(paths.statePath)) saveState({ pins: {}, presence: {} }, paths);
  return paths;
}

export function loadConfig(paths = getPaths()): Config {
  if (!existsSync(paths.configPath)) return structuredClone(DEFAULT_CONFIG);
  const raw = parseYaml(readFileSync(paths.configPath, "utf8")) ?? {};
  return {
    version: 1,
    author: raw.author,
    spaces: raw.spaces ?? {},
    projects: raw.projects ?? {},
    importMaps: raw.importMaps,
  };
}

export function saveConfig(config: Config, paths = getPaths()): void {
  const text = `# memfed configuration (edited by 'memfed' commands; safe to hand-edit)\n${stringifyYaml(
    config,
    { lineWidth: 0 },
  )}`;
  atomicWrite(paths.configPath, text, 0o600);
}

export function loadState(paths = getPaths()): State {
  if (!existsSync(paths.statePath)) return { pins: {}, presence: {} };
  try {
    const raw = JSON.parse(readFileSync(paths.statePath, "utf8"));
    return {
      pins: raw.pins ?? {},
      presence: raw.presence ?? {},
      quarantined: raw.quarantined ?? [],
    };
  } catch {
    return { pins: {}, presence: {} };
  }
}

export function saveState(state: State, paths = getPaths()): void {
  atomicWrite(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

function atomicWrite(file: string, data: string, mode: number): void {
  const tmp = join(dirname(file), `.${Date.now()}-${process.pid}.tmp`);
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, file);
}

/** Quarantined record ids (RFC §16 T2) as a fast lookup set. */
export function quarantineSet(paths = getPaths()): Set<string> {
  return new Set(loadState(paths).quarantined ?? []);
}

let cachedAuthor: string | undefined;

/** Provenance author: config override -> git config user.email -> OS username. */
export function resolveAuthor(config?: Config): string {
  if (config?.author) return config.author;
  if (cachedAuthor) return cachedAuthor;
  try {
    const email = execFileSync("git", ["config", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (email) {
      cachedAuthor = email;
      return email;
    }
  } catch {
    /* fall through */
  }
  cachedAuthor = userInfo().username;
  return cachedAuthor;
}
