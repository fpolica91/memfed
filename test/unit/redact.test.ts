import { describe, expect, it } from "vitest";
import { applyFixes, isDirty, scan } from "../../src/redact/scan.js";

const POSITIVES: Array<{ name: string; text: string; rule: string }> = [
  { name: "AWS access key", text: "key is AKIAIOSFODNN7EXAMPLE ok", rule: "aws-access-key-id" },
  {
    name: "GitHub PAT",
    text: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here",
    rule: "github-token",
  },
  { name: "GitLab PAT", text: "use glpat-AbCdEf123456789012345 now", rule: "gitlab-pat" },
  { name: "Slack token", text: "xoxb-123456789012-abcdefghij", rule: "slack-token" },
  { name: "Stripe live", text: `sk_live_${"abcdefghijklmnopqrst1234"}`, rule: "stripe-secret-key" },
  {
    name: "Anthropic key",
    text: "sk-ant-api03-abcdefghijklmnopqrstuvwx",
    rule: "anthropic-api-key",
  },
  { name: "OpenAI key", text: "sk-proj4abcdefghijklmnopqrstuvwx", rule: "openai-api-key" },
  { name: "HF token", text: "hf_abcdefghijklmnopqrstuvwxyz012345", rule: "huggingface-token" },
  { name: "GCP API key", text: "AIzaSyA1234567890abcdefghijklmnopqrstuv", rule: "gcp-api-key" },
  {
    name: "service account",
    text: '{"type": "service_account", "project_id": "x"}',
    rule: "gcp-service-account",
  },
  {
    name: "private key",
    text: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
    rule: "private-key-block",
  },
  {
    name: "JWT",
    text: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P",
    rule: "jwt",
  },
  {
    name: "connection string",
    text: "postgres://admin:hunter22@db.internal:5432/prod",
    rule: "connection-string-userinfo",
  },
  {
    name: "env pair",
    text: "export STRIPE_SECRET=whsec_9f8g7h6j5k4l3m2n1",
    rule: "env-credential-pair",
  },
  {
    name: "authorization header",
    text: "Authorization: Bearer AbCd1234EfGh5678IjKl",
    rule: "authorization-header",
  },
  {
    name: "entropy near keyword",
    text: "the api key is Zq9mK2xVb8Rf4Wc7Jh3Np6Td1Ys5Lg0A",
    rule: "entropy-with-context",
  },
];

const NEGATIVES: Array<{ name: string; text: string }> = [
  { name: "git sha near commit", text: "commit 4f2c9b1e7a8d3f6c5b2a1d9e8f7c6b5a4d3e2f1a fixed it" },
  { name: "short git sha", text: "see commit 4f2c9b1 on main" },
  { name: "ULID", text: "record 01JZX5M8Q0V7T3E9RWN2K4YHBD supersedes it" },
  { name: "UUID", text: "session 550e8400-e29b-41d4-a716-446655440000 ended" },
  { name: "prose", text: "We decided to rotate refresh tokens on every exchange after the incident." },
  { name: "env placeholder", text: "set API_KEY=<your-api-key-here> in .env" },
  { name: "env var reference", text: "export DATABASE_PASSWORD=${DB_PASS}" },
  { name: "sha256 mention", text: "digest sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  { name: "package versions", text: "typescript@7.0.2 vitest@4.1.10 commander@15.0.0" },
  { name: "markdown code", text: "run `npm install memfed` then `memfed init`" },
];

describe("redaction scan", () => {
  for (const p of POSITIVES) {
    it(`BLOCKS ${p.name}`, () => {
      const result = scan(p.text);
      expect(result.blocks.length, `expected a block for: ${p.text}`).toBeGreaterThan(0);
      expect(result.blocks.map((f) => f.ruleId)).toContain(p.rule);
    });
  }

  it("negatives corpus produces no blocks", () => {
    for (const n of NEGATIVES) {
      const result = scan(n.text);
      expect(result.blocks, `false positive on '${n.name}': ${JSON.stringify(result.blocks)}`).toEqual(
        [],
      );
    }
  });

  it("never stores the raw secret in findings (INV-5)", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const result = scan(`key ${secret} end`);
    const serialized = JSON.stringify(result.findings);
    expect(serialized).not.toContain(secret);
    expect(result.findings[0]?.excerpt).toMatch(/^AKIA… \(20 chars\)$/);
  });

  it("warns on home paths and offers a fix", () => {
    const text = "logs at /home/fabricio/project/logs/app.log were rotated";
    const result = scan(text);
    const finding = result.warns.find((f) => f.ruleId === "home-path");
    expect(finding).toBeDefined();
    expect(applyFixes(text, result.findings)).toContain("~/project/logs/app.log");
  });

  it("skips the record author's own email but flags others", () => {
    const text = "ask alice@corp.example or bob@other.example";
    const result = scan(text, { selfAuthor: "alice@corp.example" });
    const emails = result.warns.filter((f) => f.ruleId === "email");
    expect(emails).toHaveLength(1);
  });

  it("honors allowlist fingerprints", () => {
    const text = "key AKIAIOSFODNN7EXAMPLE end";
    const first = scan(text);
    expect(first.blocks).toHaveLength(1);
    const allow = [{ ruleId: first.blocks[0]!.ruleId, fingerprint: first.blocks[0]!.fingerprint }];
    expect(scan(text, { allow }).blocks).toHaveLength(0);
  });

  it("isDirty is true only for block-level content", () => {
    expect(isDirty("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(isDirty("visit 8.8.8.8 sometime")).toBe(false); // warn-only
    expect(isDirty("plain decision text")).toBe(false);
  });
});
