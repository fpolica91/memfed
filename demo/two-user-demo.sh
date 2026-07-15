#!/usr/bin/env bash
# memfed two-persona demo (RFC-0001 Appendix A).
#
# One machine, two people:
#   alice — captures privately, hits the redaction gate, fixes, publishes
#   bob   — joins the space, syncs, and sees the record in his own tools
#
# Usage:
#   demo/two-user-demo.sh                 # alice = your real env (~/.memfed)
#   demo/two-user-demo.sh --isolated     # alice sandboxed too (CI-safe)
#   demo/two-user-demo.sh --cli-only     # skip the claude/codex phases
#   demo/two-user-demo.sh --clean        # remove demo artifacts at the end

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=demo/lib.sh
source "$REPO_ROOT/demo/lib.sh"

CLI_ONLY=0
ISOLATED=0
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --cli-only) CLI_ONLY=1 ;;
    --isolated) ISOLATED=1 ;;
    --clean) CLEAN=1 ;;
    *) die "unknown flag: $arg" ;;
  esac
done

MEMFED_CMD=${MEMFED_BIN:-"$REPO_ROOT/node_modules/.bin/tsx $REPO_ROOT/src/cli/index.ts"}
DEMO_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/memfed-demo.XXXXXX")"
REMOTE="$DEMO_ROOT/remotes/platform-memory.git"
PROJECT_DIR="$DEMO_ROOT/proj/payments-api"

# --- personas ---------------------------------------------------------------
BOB_HOME="$DEMO_ROOT/bob-memfed"
BOB_GITCONFIG="$DEMO_ROOT/bob.gitconfig"
make_persona_gitconfig "bob" "$BOB_GITCONFIG"
bob() { MEMFED_HOME="$BOB_HOME" GIT_CONFIG_GLOBAL="$BOB_GITCONFIG" NO_COLOR=1 $MEMFED_CMD "$@"; }

if [ "$ISOLATED" -eq 1 ]; then
  ALICE_HOME="$DEMO_ROOT/alice-memfed"
  ALICE_GITCONFIG="$DEMO_ROOT/alice.gitconfig"
  make_persona_gitconfig "alice" "$ALICE_GITCONFIG"
  alice() { MEMFED_HOME="$ALICE_HOME" GIT_CONFIG_GLOBAL="$ALICE_GITCONFIG" NO_COLOR=1 $MEMFED_CMD "$@"; }
else
  ALICE_HOME="${MEMFED_HOME:-$HOME/.memfed}"
  alice() { NO_COLOR=1 $MEMFED_CMD "$@"; }
fi

printf 'demo root: %s\n' "$DEMO_ROOT"

# --- 1. remote + space ------------------------------------------------------
step "create a bare remote and let alice initialize the 'platform' team space"
git init -q --bare -b main "$REMOTE"
alice init >/dev/null 2>&1 || true
OUT=$(alice space init "file://$REMOTE" --name platform --kind team --policy direct 2>&1) ||
  { printf '%s\n' "$OUT"; die "space init failed"; }
assert_contains "$OUT" "created space platform" "space initialized and pushed"

# --- 2. private capture with a planted secret --------------------------------
step "alice captures a decision — with a planted fake AWS key in the body"
OUT=$(alice add --project payments-api --type decision \
  --title "Rotate refresh tokens on every exchange" \
  --tags auth,oauth --paths 'src/auth/**' \
  --body "Rotation is mandatory. Deploy key AKIAIOSFODNN7EXAMPLE must be configured first." 2>&1)
RECORD_ID=$(printf '%s' "$OUT" | grep -oE 'created [A-Z0-9]{26}' | awk '{print $2}')
[ -n "$RECORD_ID" ] || die "could not parse record id from: $OUT"
assert_contains "$OUT" "created" "captured privately as $RECORD_ID"
assert_contains "$OUT" "redaction findings" "capture-time scan flagged the secret"

# --- 3. the redaction gate blocks --------------------------------------------
step "sharing is BLOCKED by the redaction gate (exit 2); nothing reaches the remote"
set +e
OUT=$(alice share "$RECORD_ID" --to platform --yes 2>&1)
CODE=$?
set -e
assert_exit 2 "$CODE" "share refused with redaction exit code"
assert_contains "$OUT" "aws-access-key-id" "the AWS key rule fired"
TREE=$(git --git-dir "$REMOTE" ls-tree -r --name-only main)
assert_not_contains "$TREE" "$RECORD_ID" "remote provably contains no record"

# --- 4. fix and publish -------------------------------------------------------
step "alice fixes the body and publishes (consent bypassed only via explicit --yes)"
printf 'Rotation is mandatory. Reuse of a rotated token revokes the whole grant chain.\n' |
  alice edit "$RECORD_ID" --body-file - >/dev/null
OUT=$(alice share "$RECORD_ID" --to platform --yes 2>&1)
assert_contains "$OUT" "published" "record published to 'platform'"
TREE=$(git --git-dir "$REMOTE" ls-tree -r --name-only main)
assert_contains "$TREE" "records/$RECORD_ID.md" "record file is on the remote"
assert_contains "$(cat "$ALICE_HOME/audit.jsonl")" '"action":"publish"' "publish audit event logged"

# --- 5. bob joins and syncs ---------------------------------------------------
step "bob (separate home + git identity) joins the space and finds alice's record"
bob init >/dev/null
OUT=$(bob space add "file://$REMOTE" 2>&1)
assert_contains "$OUT" "joined space platform" "bob joined"
OUT=$(bob search refresh token rotation 2>&1)
assert_contains "$OUT" "Rotate refresh tokens on every exchange" "bob's search finds it"
OUT=$(bob show "$RECORD_ID" 2>&1)
assert_contains "$OUT" "alice" "provenance survives federation"

# --- 6+7. assistants see it (needs M3 'connect'; auto-skipped before that) ----
has_subcommand() { bob --help 2>/dev/null | grep -qE "^\s+$1"; }

if [ "$CLI_ONLY" -eq 1 ]; then
  skip "claude/codex phases (--cli-only)"
elif ! has_subcommand connect; then
  skip "claude/codex phases ('memfed connect' not built yet — M3)"
else
  mkdir -p "$PROJECT_DIR"
  printf 'project: payments-api\nspaces:\n  - platform\n' > "$PROJECT_DIR/.memfed.yaml"

  step "bob connects the project: AGENTS.md managed block + .mcp.json"
  OUT=$(cd "$PROJECT_DIR" && bob connect claude --project . 2>&1)
  assert_contains "$(cat "$PROJECT_DIR/AGENTS.md")" "Rotate refresh tokens" "AGENTS.md block carries the record one-liner"
  assert_contains "$(cat "$PROJECT_DIR/.mcp.json")" '"memfed"' ".mcp.json registers the MCP server"

  if command -v claude >/dev/null 2>&1; then
    step "headless Claude Code retrieves the record through MCP"
    set +e
    OUT=$(cd "$PROJECT_DIR" && MEMFED_HOME="$BOB_HOME" GIT_CONFIG_GLOBAL="$BOB_GITCONFIG" \
      claude -p "Call the mem_search tool with query 'refresh token rotation' and print the matching record's exact title." \
      --mcp-config .mcp.json --strict-mcp-config \
      --allowedTools "mcp__memfed__mem_search" --max-turns 3 2>&1)
    CODE=$?
    set -e
    if [ $CODE -eq 0 ]; then
      assert_contains "$OUT" "Rotate refresh tokens on every exchange" "claude -p returned the federated record"
    else
      skip "claude -p failed (auth/session issue?) — output: $(printf '%s' "$OUT" | tail -3)"
    fi
  else
    skip "claude not on PATH"
  fi

  if command -v codex >/dev/null 2>&1; then
    step "codex registers the MCP server (isolated CODEX_HOME — your real ~/.codex is untouched)"
    BOB_CODEX="$DEMO_ROOT/bob-codex"
    mkdir -p "$BOB_CODEX"
    OUT=$(cd "$PROJECT_DIR" && CODEX_HOME="$BOB_CODEX" MEMFED_HOME="$BOB_HOME" \
      GIT_CONFIG_GLOBAL="$BOB_GITCONFIG" NO_COLOR=1 $MEMFED_CMD connect codex --project . 2>&1)
    assert_contains "$OUT" "registered" "memfed connect codex ran 'codex mcp add'"
    OUT=$(CODEX_HOME="$BOB_CODEX" codex mcp list 2>&1 || true)
    assert_contains "$OUT" "memfed" "codex mcp list shows memfed"
  else
    skip "codex not on PATH"
  fi
fi

# --- 8. collision brief (M5; auto-skipped before that) -------------------------
if has_subcommand brief; then
  step "collision awareness: alice publishes in billing; bob's brief names her"
  OUT=$(alice add --project payments-api --type decision \
    --title "Billing retries use exponential backoff" \
    --paths 'src/billing/**' --body "Max 5 retries, 2^n seconds, jitter." 2>&1)
  BILLING_ID=$(printf '%s' "$OUT" | grep -oE 'created [A-Z0-9]{26}' | awk '{print $2}')
  alice share "$BILLING_ID" --to platform --yes >/dev/null
  alice presence set --space platform --note "reworking billing retries this week" \
    --areas billing --project payments-api >/dev/null
  bob sync >/dev/null
  OUT=$(bob brief --project payments-api --paths 'src/billing/**' 2>&1)
  assert_contains "$OUT" "alice" "bob's brief names alice in his areas"
  assert_contains "$OUT" "reworking billing retries" "alice's opt-in presence note reaches bob's brief"
else
  skip "brief phase ('memfed brief' not built yet — M5)"
fi

printf '\n\033[1;32mDEMO COMPLETE\033[0m — artifacts in %s\n' "$DEMO_ROOT"
if [ "$CLEAN" -eq 1 ]; then
  rm -rf "$DEMO_ROOT"
  printf 'cleaned.\n'
fi
