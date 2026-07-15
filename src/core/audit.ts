import { appendFileSync } from "node:fs";
import { getPaths } from "./config.js";
import { nowIso } from "./types.js";

export type AuditAction =
  | "init"
  | "add"
  | "edit"
  | "import"
  | "propose"
  | "approve"
  | "reject"
  | "expire"
  | "publish"
  | "promote"
  | "retract"
  | "supersede"
  | "quarantine"
  | "redaction-block"
  | "redaction-override"
  | "sync"
  | "rewrite-accepted"
  | "presence";

export interface AuditEvent {
  action: AuditAction;
  record_id?: string;
  space?: string;
  origin?: "cli" | "mcp";
  commit?: string;
  /** Redaction finding identities: ruleId + fingerprint + masked excerpt only (INV-5). */
  findings?: Array<{ ruleId: string; fingerprint: string; excerpt: string }>;
  reason?: string;
  details?: Record<string, unknown>;
}

/** Append-only local audit log (RFC §2 P5). Never stores raw secret values. */
export function appendAudit(event: AuditEvent, auditPath = getPaths().auditPath): void {
  const line = JSON.stringify({ ts: nowIso(), ...event });
  appendFileSync(auditPath, `${line}\n`, { mode: 0o600 });
}
