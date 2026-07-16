# memfed

**Federated, privacy-first shared memory for AI coding assistants.**

Your assistants (Claude Code, Codex, Crush, Cursor, …) each remember things — but only for you, and only in their own format. memfed turns those memories into *team knowledge* without a server, without accounts, and without ever sharing anything you didn't explicitly approve:

- **Private by default.** Every capture lands in a local store (`~/.memfed`). Nothing leaves your machine except by an explicit, reviewed, redaction-gated action.
- **Federation = git.** Shared memory lives in **spaces** — plain git repos. Auth *is* repo permissions, review *is* a PR, audit *is* git history. Any CLI user can create org memory with nothing but git.
- **Tool-neutral.** One record format, one MCP server, one managed `AGENTS.md` block. Anything that speaks MCP or reads AGENTS.md participates.
- **Machines stage, humans publish.** Assistants can *propose* sharing a memory; only you can publish it — after seeing the full body, the destination's readership, and every redaction finding.
- **Collision awareness without surveillance.** A session brief tells you which teammates were recently active in your areas and which decisions were just published — derived from metadata, honestly labeled "recent activity", never "live presence".

Spec: [RFC-0001](docs/rfc-0001-memfed.md) · Status: **v0.1 (working MVP)** · License: Apache-2.0

## The five pains this answers

| Pain (from market research) | memfed's answer |
|---|---|
| "I want to share *some* memories, never all" | Private-by-default store; per-record consent ceremony; MCP writes are staging-only |
| "My local memory never becomes org knowledge" | Candidate suggestions → review queue → publish; `promote` to org spaces via PR gate |
| "Desktop users get org memory, CLI users don't" | Pure CLI + git; an org space is `memfed space init <git-url>` away |
| "Privacy, but I don't want us colliding on work" | Metadata-only activity brief (`memfed brief`) with an OVERLAP section |
| "We use Claude Code AND Codex AND Crush" | Neutral records + MCP server + AGENTS.md projection; importers for existing stores |

## Quickstart

```bash
npm install -g memfed        # or run from a checkout: node_modules/.bin/tsx src/cli/index.ts
memfed init                  # private store at ~/.memfed
memfed doctor                # check runtime, git identity, assistants on PATH

# --- create (or join) a team space: any git repo you can push to ---
memfed space init git@github.com:acme/platform-memory.git --name platform --kind team
#   teammates: memfed space add git@github.com:acme/platform-memory.git

# --- capture privately (or let your assistant do it via MCP mem_add) ---
memfed add --project payments-api --type decision \
  --title "Rotate refresh tokens on every exchange" \
  --body "Reuse of a rotated token revokes the whole grant chain."

# --- share by consent: redaction gate -> full-body preview -> publish ---
memfed share <id> --to platform

# --- teammates pull it into every assistant ---
memfed sync                          # fetch/rebase/push + refresh projections
memfed search "refresh token"        # your memory + the team's, labeled

# --- wire your assistants (per project, needs a .memfed.yaml marker) ---
printf 'project: payments-api\nspaces:\n  - platform\n' > .memfed.yaml
memfed connect claude    # .mcp.json + AGENTS.md managed block
memfed connect codex     # codex mcp add + AGENTS.md
memfed connect cursor    # .cursor/mcp.json + AGENTS.md
memfed connect crush     # crush.json (experimental)

# --- start-of-session awareness ---
memfed brief --paths 'src/billing/**'   # who's been in your areas + fresh decisions
memfed suggest --propose                # deterministic share candidates -> review queue
memfed status                           # store, queue, spaces, promotion drift

# --- bring your existing memory along (lands private, as candidates) ---
memfed import claude-mem             # decisions from ~/.claude-mem (read-only)
memfed import claude-native          # Claude Code's per-project memory files
```

Run the whole story end-to-end on one machine (two personas, a bare remote, a planted
fake AWS key that gets blocked, headless Claude Code retrieving the record via MCP):

```bash
demo/two-user-demo.sh --isolated
```

## How sharing actually works

```
capture ──▶ suggest ──▶ propose ──▶ review ──▶ publish
(always     (local       (stages      (human      (direct push, or a
 local)     heuristics)  only, even   ceremony,   memfed/proposals/<id>
                         for agents)  full body)  branch on pr-policy spaces)
```

- The publish boundary **re-validates everything**: policy re-read from the space's own manifest, redaction re-run on the exact bytes committed, authorship re-stamped from git config. Approving an incoming proposal re-runs the gate on the **reviewer's** machine too.
- Redaction: 23 deterministic secret rules (AWS/GitHub/Stripe/OpenAI/Anthropic/PEM/JWT/connection-strings/…) that **block**, keyword-gated entropy, and PII warnings with one-key fixes. Overrides are per-finding, typed, reasoned, and audited. It is a seatbelt, not a guarantee — a pushed secret is fixed by *rotation*, and the CLI says so.
- Lifecycle: published bodies are immutable — corrections `supersede`, mistakes `retract` (tombstone), poison gets `quarantine`d locally (kill-switch). Stale records age out of projections via `review_after`.
- Integrity: TOFU commit pinning makes a rewritten space history loud on every member's machine (`--accept-rewrite` to adopt deliberately).

## Security model in one paragraph

A record's scope *is* the set of git repos it's published to — there is no scope field to lie. Nothing on your machine is ever transmitted by search, dedup, or briefs (testable invariant); the first network act in a record's life is its publish commit. Agents can read team memory and stage proposals, but no MCP code path reaches `git push`. Projections into AGENTS.md are an *index* (attributed one-liners, hard token budget, style-sanitized), not a payload — one poisoned record has a one-line, attributed blast radius, and `memfed quarantine` kills it locally. Full threat model: RFC-0001 §16.

## Development

```bash
npm ci
npm test           # 74 tests: unit + git integration + MCP contract (incl. INV-2 security test)
npm run typecheck && npm run lint
npm run build      # tsup -> dist/cli.js
./demo/two-user-demo.sh --cli-only --isolated   # the CI demo subset
```

Works on Node ≥ 22.13 (`node:sqlite`) and Bun (`bun:sqlite`) through a driver seam. No native dependencies; git is shelled out to on purpose — your credential helpers and SSH agents are the auth model.

## Status & roadmap

Implemented: records/store/index, spaces, direct + PR publish flows, redaction gate, sync with TOFU pinning, MCP server (5 tools), AGENTS.md projections, connect (claude/codex/cursor/crush\*, `--hook` for a SessionStart brief), retract/supersede/quarantine/`promote`/`gardening`, importers (claude-mem, claude-native), activity briefs **plus opt-in presence files** (`memfed presence set/show/off`, TTL'd, hour-rounded, history-squashable via `space prune-presence`), space-side CI lint (`memfed lint-space`, workflow shipped by `space init`), `gh pr` sugar on GitHub remotes.
Also in: field-wise conflict auto-resolution during sync (status by safety precedence, lists unioned, remote body wins with your local body parked as a private draft), `suggest` (RFC §7.3 candidate detection), `status` (RFC §6.4 promotion drift).
Not yet: embeddings, in-repo spaces (`root:` reserved), encrypted spaces (deliberately rejected for v1). See RFC-0001 §17.

\* Crush stanza is spec-based but untested (not installed on the dev machine).
