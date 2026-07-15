import { z } from "zod";

export const RECORD_TYPES = [
  "decision",
  "convention",
  "gotcha",
  "runbook",
  "reference",
  "preference",
  "scratch",
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const RECORD_STATUSES = [
  "active",
  "superseded",
  "deprecated",
  "retracted",
  "disputed",
  "candidate",
] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/** Types eligible for share suggestions (RFC §7.3). */
export const SHAREABLE_TYPES: readonly RecordType[] = ["decision", "convention", "gotcha", "runbook"];

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** Canonical instant: second precision, UTC, Z suffix (RFC §4.2 byte stability). */
export const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_TITLE_LEN = 120;
export const MAX_BODY_BYTES = 64 * 1024;
export const RECORD_SCHEMA_VERSION = 1;

const ulid = z.string().regex(ULID_RE, "must be a 26-char uppercase ULID");
const slug = z.string().regex(SLUG_RE, "must be a lowercase slug");
const isoInstant = z.string().regex(ISO_INSTANT_RE, "must be an ISO-8601 UTC instant (…Z, second precision)");
const isoDate = z.string().regex(ISO_DATE_RE, "must be an ISO-8601 date (YYYY-MM-DD)");

export const ProvenanceSchema = z.object({
  author: z.string().min(1),
  tool: z.string().min(1),
  created: isoInstant,
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const RecordFrontmatterSchema = z.object({
  id: ulid,
  title: z
    .string()
    .min(1)
    .max(MAX_TITLE_LEN)
    .refine((s) => !/[\r\n]/.test(s), "title must be a single line"),
  type: z.enum(RECORD_TYPES),
  project: slug,
  tags: z.array(z.string().min(1)).optional(),
  paths: z.array(z.string().min(1)).optional(),
  provenance: ProvenanceSchema,
  updated: isoInstant.optional(),
  status: z.enum(RECORD_STATUSES),
  supersedes: ulid.optional(),
  superseded_by: ulid.optional(),
  relates_to: z.array(ulid).optional(),
  review_after: isoDate.optional(),
  promoted_from: z.string().optional(),
  promoted_by: z.string().optional(),
  schema_version: z.literal(RECORD_SCHEMA_VERSION),
});
export type RecordFrontmatter = z.infer<typeof RecordFrontmatterSchema>;

export interface MemoryRecord {
  fm: RecordFrontmatter;
  body: string;
}

/** Canonical frontmatter key order (RFC §4.2). */
export const FRONTMATTER_KEY_ORDER = [
  "id",
  "title",
  "type",
  "project",
  "tags",
  "paths",
  "provenance",
  "updated",
  "status",
  "supersedes",
  "superseded_by",
  "relates_to",
  "review_after",
  "promoted_from",
  "promoted_by",
  "schema_version",
] as const;

/** Space manifest — .memfed/space.yaml (RFC §6.1). */
export const SpaceManifestSchema = z.object({
  name: slug,
  kind: z.enum(["project", "team", "org"]),
  description: z.string().optional(),
  publish: z.enum(["direct", "pr"]).default("direct"),
  presence: z.enum(["on", "off"]).default("on"),
  redaction: z
    .object({ ruleset_min_version: z.number().int().min(1).default(1) })
    .default({ ruleset_min_version: 1 }),
  layout_version: z.literal(1).default(1),
});
export type SpaceManifest = z.infer<typeof SpaceManifestSchema>;

/** Project marker — .memfed.yaml at a repo root. */
export const ProjectMarkerSchema = z.object({
  project: slug,
  spaces: z.array(slug).optional(),
});
export type ProjectMarkerFile = z.infer<typeof ProjectMarkerSchema>;

export const PROPOSAL_STATES = ["proposed", "approved", "published", "rejected", "expired"] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export interface Proposal {
  id: string;
  record_id: string;
  space: string;
  state: ProposalState;
  origin: "cli" | "mcp";
  created: string;
  updated: string;
}

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

/** Now, in canonical instant form. */
export function nowIso(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}
