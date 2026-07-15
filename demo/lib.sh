#!/usr/bin/env bash
# Shared helpers for memfed demos.

STEP_N=0

step() {
  STEP_N=$((STEP_N + 1))
  printf '\n\033[1;36m== step %d: %s ==\033[0m\n' "$STEP_N" "$1"
}

pass() { printf '\033[1;32m   ok: %s\033[0m\n' "$1"; }
skip() { printf '\033[1;33m skip: %s\033[0m\n' "$1"; }
die() {
  printf '\033[1;31m FAIL: %s\033[0m\n' "$1" >&2
  exit 1
}

assert_contains() { # haystack-string needle description
  local haystack="$1" needle="$2" what="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    pass "$what"
  else
    printf '--- output was ---\n%s\n------------------\n' "$haystack" >&2
    die "$what (expected to find: $needle)"
  fi
}

assert_not_contains() { # haystack needle description
  local haystack="$1" needle="$2" what="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf '--- output was ---\n%s\n------------------\n' "$haystack" >&2
    die "$what (should NOT contain: $needle)"
  else
    pass "$what"
  fi
}

assert_exit() { # expected-code actual-code description
  if [ "$1" -eq "$2" ]; then
    pass "$3 (exit $2)"
  else
    die "$3 — expected exit $1, got $2"
  fi
}

make_persona_gitconfig() { # name path
  cat >"$2" <<EOF
[user]
	name = $1
	email = $1@demo.local
[init]
	defaultBranch = main
EOF
}
