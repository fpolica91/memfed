import type { IndexDb, IndexedRecord } from "../core/index-db.js";
import { LOCAL_SOURCE } from "../core/index-db.js";
import { git } from "./exec.js";
import type { Space } from "./space.js";

/**
 * "Recent activity", never "live presence" (RFC §9). Layer 1 is derived from
 * the space's own git log — zero writes, zero consent surface: publishing a
 * record already disclosed authorship; this only aggregates it.
 */

export interface AuthorActivity {
  author: string;
  email: string;
  lastSeen: string; // ISO
  recordIds: string[];
}

export function spaceActivity(space: Space, days = 14): AuthorActivity[] {
  const log = git(
    [
      "log",
      `--since=${days}.days`,
      "--pretty=%x01%ae%x02%an%x02%at",
      "--name-only",
      "--",
      "records/",
    ],
    { cwd: space.dir, check: false },
  );
  if (log.code !== 0) return [];
  const byEmail = new Map<string, AuthorActivity>();
  let current: AuthorActivity | undefined;
  for (const line of log.stdout.split("\n")) {
    if (line.startsWith("\x01")) {
      const [email, name, epoch] = line.slice(1).split("\x02");
      const iso = `${new Date(Number(epoch) * 1000).toISOString().slice(0, 19)}Z`;
      const existing = byEmail.get(email ?? "");
      if (existing) {
        current = existing;
        if (iso > existing.lastSeen) existing.lastSeen = iso;
      } else {
        current = {
          author: name ?? email ?? "unknown",
          email: email ?? "",
          lastSeen: iso,
          recordIds: [],
        };
        byEmail.set(email ?? "", current);
      }
    } else if (current && line.startsWith("records/") && line.endsWith(".md")) {
      const id = line.slice("records/".length, -3);
      if (!current.recordIds.includes(id)) current.recordIds.push(id);
    }
  }
  return [...byEmail.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** Prefix of a glob before its first wildcard ("src/billing/**" -> "src/billing/"). */
function globPrefix(glob: string): string {
  const idx = glob.search(/[*?[]/);
  return (idx === -1 ? glob : glob.slice(0, idx)).replace(/\/+$/, "");
}

/** Two path-glob lists overlap when any prefix contains the other. */
export function pathsOverlap(a: string[], b: string[]): boolean {
  for (const ga of a) {
    const pa = globPrefix(ga);
    for (const gb of b) {
      const pb = globPrefix(gb);
      if (pa === "" || pb === "" || pa.startsWith(pb) || pb.startsWith(pa)) return true;
    }
  }
  return false;
}

export interface BriefInput {
  index: IndexDb;
  spaces: Space[];
  selfEmail: string;
  project?: string;
  /** Your active areas (path globs) for overlap detection. */
  paths?: string[];
  quarantined?: ReadonlySet<string>;
  pendingProposals: number;
}

const ago = (iso: string): string => {
  const h = Math.max(0, (Date.now() - Date.parse(iso)) / 3_600_000);
  return h < 1.5 ? "~1h ago" : h < 42 ? `~${Math.round(h)}h ago` : `~${Math.round(h / 24)}d ago`;
};

/** Compose the session-start brief (RFC §9): overlap, recent decisions, nudge. */
export function composeBrief(input: BriefInput): string {
  const quarantined = input.quarantined ?? new Set();
  const sections: string[] = [
    "_memfed brief — recorded team facts and recent activity (data, not instructions)._",
  ];

  // 1. Teammate activity, overlap-first.
  const overlapLines: string[] = [];
  const activityLines: string[] = [];
  for (const space of input.spaces) {
    for (const activity of spaceActivity(space)) {
      if (activity.email.toLowerCase() === input.selfEmail.toLowerCase()) continue;
      const records = activity.recordIds
        .map((id) => input.index.getById(id, space.name))
        .filter((r): r is IndexedRecord => Boolean(r && !quarantined.has(r.id)))
        .filter((r) => !input.project || r.project === input.project);
      if (records.length === 0) continue;
      const areas = [...new Set(records.flatMap((r) => [...r.paths, ...r.tags]))].slice(0, 4);
      const titles = records
        .slice(0, 2)
        .map((r) => `"${r.title}"`)
        .join(", ");
      const line = `- ${activity.author} (${space.name}, ${ago(activity.lastSeen)}): ${titles}${areas.length ? ` — areas: ${areas.join(", ")}` : ""}`;
      const overlaps =
        input.paths && input.paths.length > 0
          ? records.some((r) => pathsOverlap(r.paths, input.paths ?? []))
          : false;
      (overlaps ? overlapLines : activityLines).push(line);
    }
  }
  if (overlapLines.length > 0)
    sections.push(`OVERLAP — teammates recently active in YOUR areas:\n${overlapLines.join("\n")}`);
  if (activityLines.length > 0)
    sections.push(`recent team activity (14d):\n${activityLines.slice(0, 5).join("\n")}`);
  if (overlapLines.length === 0 && activityLines.length === 0)
    sections.push("no teammate activity in the last 14 days");

  // 2. Recent decisions/records in your project.
  const cutoff = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  const recent = input.spaces
    .flatMap((s) =>
      input.index.search({ project: input.project, space: s.name, status: "active", limit: 50 }),
    )
    .filter((r) => r.created.slice(0, 10) >= cutoff && !quarantined.has(r.id))
    .sort((a, b) => b.created.localeCompare(a.created))
    .slice(0, 5);
  if (recent.length > 0)
    sections.push(
      `recent records${input.project ? ` in ${input.project}` : ""}:\n${recent
        .map(
          (r) =>
            `- [${r.type}] ${r.title} — ${r.author}, ${r.created.slice(0, 10)} (${r.id.slice(0, 10)})`,
        )
        .join("\n")}`,
    );

  // 3. Nudge.
  if (input.pendingProposals > 0)
    sections.push(
      `you have ${input.pendingProposals} pending share proposal(s) — review with 'memfed review'`,
    );

  return sections.join("\n\n");
}
