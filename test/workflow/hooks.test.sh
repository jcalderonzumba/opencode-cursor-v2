#!/usr/bin/env bash
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOKS="$ROOT/.githooks"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com

N=0

# new_repo [seed]: sets W to a fresh work repo wired to the hooks; with "seed" it also has a bare remote and an unpushed commit on main (git skips pre-push when there is nothing to push).
new_repo() {
  N=$((N + 1))
  W="$TMP/w$N"
  git init -q -b main "$W"
  if [ "${1:-}" = seed ]; then
    git init -q --bare -b main "$TMP/r$N.git"
    git -C "$W" remote add origin "$TMP/r$N.git"
    git -C "$W" commit -q --allow-empty -m seed
    git -C "$W" push -q origin main
    git -C "$W" commit -q --allow-empty -m unpushed
  fi
  git -C "$W" config core.hooksPath "$HOOKS"
}

assert_refuses() {
  local desc=$1 err
  shift
  if err=$("$@" 2>&1 >/dev/null); then
    echo "FAIL $desc: command succeeded" >&2
    exit 1
  fi
  case $err in
    *"pre-"*": refusing"*main*) ;;
    *) echo "FAIL $desc: stderr lacks the hook's refusal naming main: $err" >&2; exit 1 ;;
  esac
  echo "ok $desc"
}

assert_allows() {
  local desc=$1 out
  shift
  if ! out=$("$@" 2>&1); then
    echo "FAIL $desc: $out" >&2
    exit 1
  fi
  echo "ok $desc"
}

# The seed commit and push run before core.hooksPath is set, so the hooks never see them.
new_repo seed
assert_refuses "commit on main is refused" git -C "$W" commit -q --allow-empty -m x

new_repo
assert_refuses "first commit on unborn main is refused" git -C "$W" commit -q --allow-empty -m x

new_repo seed
git -C "$W" checkout -q -b feature
assert_allows "commit on a feature branch is allowed" git -C "$W" commit -q --allow-empty -m x

new_repo seed
git -C "$W" checkout -q --detach
assert_allows "commit on detached HEAD is allowed" git -C "$W" commit -q --allow-empty -m x

new_repo seed
assert_refuses "push main is refused" git -C "$W" push origin main

new_repo seed
git -C "$W" checkout -q -b feature
assert_refuses "push HEAD:main from a feature branch is refused" git -C "$W" push origin HEAD:main

new_repo seed
assert_refuses "push :main (delete) is refused" git -C "$W" push origin :main

new_repo seed
assert_allows "push main:other is allowed" git -C "$W" push origin main:other

new_repo seed
git -C "$W" checkout -q -b feature
assert_allows "push a feature branch is allowed" git -C "$W" push origin feature
