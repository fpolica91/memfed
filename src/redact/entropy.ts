/**
 * Stage-2: keyword-gated entropy detection (RFC §16 T3).
 * High-entropy token + credential keyword nearby => BLOCK; entropy alone => WARN.
 */

const CANDIDATE_RE = /[A-Za-z0-9+/=_-]{20,}/g;
const CONTEXT_KEYWORD_RE =
  /secret|token|passwd|password|credential|api[-_ ]?key|apikey|private[-_ ]?key|auth|bearer/i;
const CONTEXT_WINDOW = 48;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ULID_TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX_RE = /^[0-9a-fA-F]+$/;

export interface EntropyHit {
  index: number;
  length: number;
  entropy: number;
  hasContext: boolean;
}

export function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function findEntropyHits(text: string): EntropyHit[] {
  const hits: EntropyHit[] = [];
  for (const m of text.matchAll(CANDIDATE_RE)) {
    const token = m[0];
    const index = m.index ?? 0;
    // Structured identifiers that merely look random:
    if (UUID_RE.test(token) || ULID_TOKEN_RE.test(token)) continue;
    // Pure hex without context is almost always a digest (git sha, sha256).
    const context = text.slice(
      Math.max(0, index - CONTEXT_WINDOW),
      index + token.length + CONTEXT_WINDOW,
    );
    const hasContext = CONTEXT_KEYWORD_RE.test(context);
    if (HEX_RE.test(token) && !hasContext) continue;
    const entropy = shannonEntropy(token);
    if (hasContext && entropy >= 4.0)
      hits.push({ index, length: token.length, entropy, hasContext });
    else if (!hasContext && entropy >= 4.7 && token.length >= 32)
      hits.push({ index, length: token.length, entropy, hasContext });
  }
  return hits;
}
