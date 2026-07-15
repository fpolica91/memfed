/**
 * Deterministic secret patterns (RFC §16 T3, INV-3). Stage-1 of the redaction
 * pipeline: high-precision rules translated from gitleaks' MIT ruleset.
 * THE most safety-critical file in the codebase — additions welcome, removals suspect.
 */

export const RULESET_VERSION = 1;

export type Severity = "block" | "warn";

export interface RedactionRule {
  id: string;
  description: string;
  severity: Severity;
  pattern: RegExp;
  /** Skip match when the captured value looks like a placeholder (docs/examples). */
  placeholderExempt?: boolean;
}

/** Placeholder-shaped values we do not flag in env-pair/header rules. */
export const PLACEHOLDER_RE =
  /^(?:<[^>]*>?|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\*{3,}|x{4,}|\.{3,}|your[-_a-z]*|changeme|placeholder|redacted|dummy|example[-_a-z0-9]*|todo)$/i;

export const RULES: readonly RedactionRule[] = [
  {
    id: "aws-access-key-id",
    description: "AWS access key ID",
    severity: "block",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "github-token",
    description: "GitHub token",
    severity: "block",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
  },
  {
    id: "gitlab-pat",
    description: "GitLab personal access token",
    severity: "block",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "slack-token",
    description: "Slack token",
    severity: "block",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "stripe-secret-key",
    description: "Stripe live secret/restricted key",
    severity: "block",
    pattern: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: "anthropic-api-key",
    description: "Anthropic API key",
    severity: "block",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "openai-api-key",
    description: "OpenAI API key",
    severity: "block",
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "npm-token",
    description: "npm access token",
    severity: "block",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "pypi-token",
    description: "PyPI upload token",
    severity: "block",
    pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}\b|\bpypi-[A-Za-z0-9_-]{50,}\b/g,
  },
  {
    id: "huggingface-token",
    description: "Hugging Face token",
    severity: "block",
    pattern: /\bhf_[A-Za-z0-9]{30,}\b/g,
  },
  {
    id: "sendgrid-token",
    description: "SendGrid API key",
    severity: "block",
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: "gcp-api-key",
    description: "Google Cloud API key",
    severity: "block",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "gcp-service-account",
    description: "GCP service-account JSON",
    severity: "block",
    pattern: /"type"\s*:\s*"service_account"/g,
  },
  {
    id: "private-key-block",
    description: "PEM private key",
    severity: "block",
    pattern: /-----BEGIN\s[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: "jwt",
    description: "JSON Web Token",
    severity: "block",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  },
  {
    id: "connection-string-userinfo",
    description: "Connection string with embedded credentials",
    severity: "block",
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|ftp|sftp):\/\/[^\s:@/]+:[^\s@/]+@/gi,
  },
  {
    id: "url-basic-auth",
    description: "URL with embedded credentials",
    severity: "warn",
    pattern: /\bhttps?:\/\/[^\s:@/]+:[^\s@/]+@/gi,
  },
  {
    id: "azure-account-key",
    description: "Azure storage account key",
    severity: "block",
    pattern: /AccountKey=[A-Za-z0-9+/=]{40,}/g,
  },
  {
    id: "azure-sas-sig",
    description: "Azure SAS signature parameter",
    severity: "warn",
    pattern: /[?&]sig=[A-Za-z0-9%+/=]{20,}/g,
  },
  {
    id: "twilio-api-key",
    description: "Twilio API key SID",
    severity: "block",
    pattern: /\bSK[0-9a-fA-F]{32}\b/g,
  },
  {
    id: "telegram-bot-token",
    description: "Telegram bot token",
    severity: "block",
    pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g,
  },
  {
    id: "env-credential-pair",
    description: "KEY=VALUE credential assignment",
    severity: "block",
    placeholderExempt: true,
    pattern:
      /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*\s*[=:]\s*["']?(?<value>[^\s"']{8,})/g,
  },
  {
    id: "authorization-header",
    description: "Authorization header with credentials",
    severity: "block",
    placeholderExempt: true,
    pattern: /\bAuthorization:\s*(?:Basic|Bearer)\s+(?<value>[A-Za-z0-9._~+/=-]{8,})/gi,
  },
];
