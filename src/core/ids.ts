import { monotonicFactory } from "ulidx";

const factory = monotonicFactory();

/** New uppercase monotonic ULID. */
export function newId(): string {
  return factory();
}

export function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

/** Resolve a possibly-abbreviated id prefix against a list of known ids. */
export function resolveIdPrefix(prefix: string, known: string[]): string {
  const p = prefix.replace(/…$/, "").toUpperCase();
  const hits = known.filter((k) => k.startsWith(p));
  if (hits.length === 1) return hits[0] as string;
  if (hits.length === 0) throw new Error(`no record matches id '${prefix}'`);
  throw new Error(`ambiguous id '${prefix}' (${hits.length} matches)`);
}
