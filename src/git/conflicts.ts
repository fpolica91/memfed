import type { MemoryRecord, RecordStatus } from "../core/types.js";

/** Safety precedence (RFC §8): a retraction always wins. */
const STATUS_PRECEDENCE: Record<RecordStatus, number> = {
  retracted: 5,
  deprecated: 4,
  superseded: 3,
  disputed: 2,
  active: 1,
  candidate: 0,
};

export interface MergeOutcome {
  merged: MemoryRecord;
  /** Set when bodies diverged: remote won, this local body should be parked as a draft. */
  parkedBody?: string;
}

function union(a?: string[], b?: string[]): string[] | undefined {
  const set = new Set([...(a ?? []), ...(b ?? [])]);
  return set.size ? [...set].sort() : undefined;
}

function maxIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function minIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

/**
 * Field-wise record merge for divergent edits of the same record (RFC §8).
 * Deterministic, no custom git merge drivers: status by safety precedence,
 * updated=max, lists=union, review_after=min (reviews sooner), divergent
 * bodies => remote wins and the local body is parked for a human.
 */
export function mergeRecords(ours: MemoryRecord, theirs: MemoryRecord): MergeOutcome {
  if (ours.fm.id !== theirs.fm.id)
    throw new Error(`mergeRecords: id mismatch ${ours.fm.id} vs ${theirs.fm.id}`);

  const status =
    STATUS_PRECEDENCE[ours.fm.status] >= STATUS_PRECEDENCE[theirs.fm.status]
      ? ours.fm.status
      : theirs.fm.status;

  const bodiesDiverge = ours.body.trim() !== theirs.body.trim();
  const titlesDiverge = ours.fm.title !== theirs.fm.title;

  const merged: MemoryRecord = {
    fm: {
      ...theirs.fm, // remote is canonical for content-ish and provenance fields
      status,
      updated: maxIso(ours.fm.updated, theirs.fm.updated),
      tags: union(ours.fm.tags, theirs.fm.tags),
      paths: union(ours.fm.paths, theirs.fm.paths),
      relates_to: union(ours.fm.relates_to, theirs.fm.relates_to),
      review_after: minIso(ours.fm.review_after, theirs.fm.review_after),
      supersedes: theirs.fm.supersedes ?? ours.fm.supersedes,
      superseded_by: theirs.fm.superseded_by ?? ours.fm.superseded_by,
    },
    body: theirs.body,
  };

  return bodiesDiverge || titlesDiverge ? { merged, parkedBody: ours.body } : { merged };
}
