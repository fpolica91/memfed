import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { findEntropyHits } from "./entropy.js";
import { PLACEHOLDER_RE, RULES, RULESET_VERSION, type Severity } from "./rules.js";

export { RULESET_VERSION };

export interface Finding {
  ruleId: string;
  description: string;
  severity: Severity;
  index: number;
  length: number;
  /** Masked excerpt: first 4 chars + length. NEVER the raw value (INV-5). */
  excerpt: string;
  line: number;
  /** sha256 of the matched span — allowlist/audit identity that leaks nothing. */
  fingerprint: string;
  /** Auto-fix replacement, when one is safe (PII stage). */
  fix?: string;
}

export interface ScanOptions {
  /** Provenance author — their own email is not PII to them. */
  selfAuthor?: string;
  /** Allowlisted (ruleId, fingerprint) pairs to suppress. */
  allow?: ReadonlyArray<{ ruleId: string; fingerprint: string }>;
}

export interface ScanResult {
  findings: Finding[];
  blocks: Finding[];
  warns: Finding[];
  rulesetVersion: number;
}

const HOME_PATH_RE = /(?:\/home\/|\/Users\/)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._/-]*)?/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const INTERNAL_HOST_RE = /\b[a-z0-9][a-z0-9.-]*\.(?:internal|corp|intra|lan)\b/g;

export function fingerprintSpan(span: string): string {
  return createHash("sha256").update(span).digest("hex").slice(0, 32);
}

export function maskExcerpt(span: string): string {
  const head = span.slice(0, 4);
  return `${head}… (${span.length} chars)`;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function isPrivateIp(ip: string): boolean {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("127.") ||
    ip === "0.0.0.0"
  );
}

/** Full scan: deterministic rules -> entropy -> PII. Findings sorted by index, overlaps deduped. */
export function scan(text: string, opts: ScanOptions = {}): ScanResult {
  const findings: Finding[] = [];

  // Stage 1 — deterministic secret patterns
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const m of text.matchAll(rule.pattern)) {
      const span = m[0];
      const value = m.groups?.value;
      if (rule.placeholderExempt && value && PLACEHOLDER_RE.test(value)) continue;
      findings.push({
        ruleId: rule.id,
        description: rule.description,
        severity: rule.severity,
        index: m.index ?? 0,
        length: span.length,
        excerpt: maskExcerpt(span),
        line: lineOf(text, m.index ?? 0),
        fingerprint: fingerprintSpan(span),
      });
    }
  }

  // Stage 2 — keyword-gated entropy
  for (const hit of findEntropyHits(text)) {
    const span = text.slice(hit.index, hit.index + hit.length);
    findings.push({
      ruleId: hit.hasContext ? "entropy-with-context" : "entropy",
      description: hit.hasContext
        ? `high-entropy token (${hit.entropy.toFixed(2)}) near credential keyword`
        : `high-entropy token (${hit.entropy.toFixed(2)})`,
      severity: hit.hasContext ? "block" : "warn",
      index: hit.index,
      length: hit.length,
      excerpt: maskExcerpt(span),
      line: lineOf(text, hit.index),
      fingerprint: fingerprintSpan(span),
    });
  }

  // Stage 3 — PII / context scrubbing (warn + auto-fix)
  for (const m of text.matchAll(HOME_PATH_RE)) {
    const span = m[0];
    findings.push({
      ruleId: "home-path",
      description: "absolute home path",
      severity: "warn",
      index: m.index ?? 0,
      length: span.length,
      excerpt: span.length > 40 ? `${span.slice(0, 40)}…` : span,
      line: lineOf(text, m.index ?? 0),
      fingerprint: fingerprintSpan(span),
      fix: `~${span.replace(/^(?:\/home\/|\/Users\/)[A-Za-z0-9._-]+/, "")}`,
    });
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    const span = m[0];
    if (opts.selfAuthor && span.toLowerCase() === opts.selfAuthor.toLowerCase()) continue;
    findings.push({
      ruleId: "email",
      description: "email address (not the record author)",
      severity: "warn",
      index: m.index ?? 0,
      length: span.length,
      excerpt: span,
      line: lineOf(text, m.index ?? 0),
      fingerprint: fingerprintSpan(span),
    });
  }
  for (const m of text.matchAll(IP_RE)) {
    const span = m[0];
    const octets = span.split(".").map(Number);
    if (octets.some((o) => o > 255)) continue;
    findings.push({
      ruleId: isPrivateIp(span) ? "ip-private" : "ip-public",
      description: isPrivateIp(span) ? "private IP address" : "public IP address",
      severity: "warn",
      index: m.index ?? 0,
      length: span.length,
      excerpt: span,
      line: lineOf(text, m.index ?? 0),
      fingerprint: fingerprintSpan(span),
    });
  }
  for (const m of text.matchAll(INTERNAL_HOST_RE)) {
    const span = m[0];
    findings.push({
      ruleId: "internal-hostname",
      description: "internal hostname",
      severity: "warn",
      index: m.index ?? 0,
      length: span.length,
      excerpt: span,
      line: lineOf(text, m.index ?? 0),
      fingerprint: fingerprintSpan(span),
    });
  }

  // Allowlist suppression, sort, overlap dedup (keep the more severe / earlier).
  const allowed = new Set((opts.allow ?? []).map((a) => `${a.ruleId}:${a.fingerprint}`));
  const kept = findings
    .filter((f) => !allowed.has(`${f.ruleId}:${f.fingerprint}`))
    .sort((a, b) => a.index - b.index || (a.severity === b.severity ? 0 : a.severity === "block" ? -1 : 1));
  const deduped: Finding[] = [];
  for (const f of kept) {
    const prev = deduped[deduped.length - 1];
    if (prev && f.index < prev.index + prev.length) {
      if (prev.severity === "warn" && f.severity === "block") deduped[deduped.length - 1] = f;
      continue;
    }
    deduped.push(f);
  }

  return {
    findings: deduped,
    blocks: deduped.filter((f) => f.severity === "block"),
    warns: deduped.filter((f) => f.severity === "warn"),
    rulesetVersion: RULESET_VERSION,
  };
}

/** Quick capture-time check (RFC §7.1): does this text contain BLOCK-severity findings? */
export function isDirty(text: string): boolean {
  return scan(text).blocks.length > 0;
}

/** Apply the auto-fixes of the given findings (descending index so spans stay valid). */
export function applyFixes(text: string, findings: Finding[]): string {
  const fixable = findings.filter((f) => f.fix !== undefined).sort((a, b) => b.index - a.index);
  let out = text;
  for (const f of fixable) {
    out = out.slice(0, f.index) + (f.fix as string) + out.slice(f.index + f.length);
  }
  return out;
}

/** Per-user persistent false-positive suppressions (~/.memfed/redaction-allow.json). */
export function loadAllowlist(path: string): Array<{ ruleId: string; fingerprint: string }> {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
