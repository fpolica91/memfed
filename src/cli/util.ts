import pc from "picocolors";
import { type Config, getPaths, isInitialized, loadConfig, type Paths } from "../core/config.js";
import { resolveIdPrefix } from "../core/ids.js";
import { IndexDb } from "../core/index-db.js";
import { Store } from "../core/store.js";

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Exit code 2 = redaction BLOCK (RFC §14). */
export const EXIT_REDACTION_BLOCK = 2;

export interface Ctx {
  paths: Paths;
  config: Config;
  index: IndexDb;
  store: Store;
  close(): void;
}

export async function openCtx(): Promise<Ctx> {
  const paths = getPaths();
  if (!isInitialized(paths))
    throw new CliError(`memfed is not initialized at ${paths.home} — run 'memfed init' first`);
  const config = loadConfig(paths);
  const index = await IndexDb.open(paths.indexPath);
  const store = new Store(paths, index, config);
  return { paths, config, index, store, close: () => index.close() };
}

/** Resolve a possibly-abbreviated record id against everything the index knows. */
export function resolveId(ctx: Ctx, idOrPrefix: string): string {
  return resolveIdPrefix(idOrPrefix, ctx.index.idsForSource());
}

export function parseCsv(value?: string): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

export function ago(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const TYPE_COLORS: Record<string, (s: string) => string> = {
  decision: pc.magenta,
  convention: pc.cyan,
  gotcha: pc.yellow,
  runbook: pc.blue,
  reference: pc.dim,
  preference: pc.dim,
  scratch: pc.dim,
};

export function formatRow(r: {
  id: string;
  type: string;
  status: string;
  project: string;
  title: string;
  source: string;
  created: string;
}): string {
  const color = TYPE_COLORS[r.type] ?? pc.dim;
  const status = r.status === "active" ? "" : pc.dim(` [${r.status}]`);
  const source = r.source === "local" ? pc.dim("private") : pc.green(r.source);
  return `${pc.dim(r.id.slice(0, 10))}  ${color(r.type.padEnd(10))} ${r.project.padEnd(16)} ${r.title}${status}  ${pc.dim(`(${source}, ${ago(r.created)})`)}`;
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
