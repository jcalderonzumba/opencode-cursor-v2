#!/usr/bin/env bash
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/load-local.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com

MARKER="SECRET-BODY-MARKER-7f3a"

# Stubs first on PATH. Both log their calls to $STUB_LOG; their behaviour comes from env vars.
mkdir "$TMP/bin"
cat >"$TMP/bin/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" >>"$STUB_LOG"
exit "${STUB_NPM_RC:-0}"
EOF
cat >"$TMP/bin/opencode" <<'EOF'
#!/usr/bin/env bash
echo "opencode $*" >>"$STUB_LOG"
case "${STUB_OC_MODE:-ok}" in
  ok) echo '{"data":[{"id":"cursor","name":"Cursor"}]}' ;;
  absent) echo '{"data":[{"id":"other"}]}' ;;
  error) echo "connection refused" >&2; exit 1 ;;
  marker)
    echo "{\"id\":\"cursor\",\"note\":\"$STUB_MARKER\"}"
    echo "$STUB_MARKER" >&2
    ;;
esac
EOF
chmod +x "$TMP/bin/npm" "$TMP/bin/opencode"

N=0
OUT="" ERR="" RC=0

# new_repo [branch|detach]: sets W to a fresh repo on main (or a feature branch, or detached), with a clean HOME and call log.
new_repo() {
  N=$((N + 1))
  W="$TMP/w$N"
  git init -q -b main "$W"
  git -C "$W" commit -q --allow-empty -m seed
  case "${1:-}" in
    branch) git -C "$W" checkout -q -b feat/x ;;
    detach) git -C "$W" checkout -q --detach ;;
  esac
  export HOME="$TMP/home$N"
  mkdir "$HOME"
  export STUB_LOG="$TMP/log$N"
  : >"$STUB_LOG"
  export STUB_MARKER="$MARKER"
  unset STUB_NPM_RC STUB_OC_MODE
}

# run: runs the script from $W with the stubs first on PATH; sets OUT, ERR, RC.
run() {
  RC=0
  PATH="$TMP/bin:$PATH" bash -c 'cd "$1" && exec bash "$2"' _ "$W" "$SCRIPT" >"$TMP/out" 2>"$TMP/err" || RC=$?
  OUT="$(cat "$TMP/out")"
  ERR="$(cat "$TMP/err")"
}

fail() {
  echo "FAIL $1" >&2
  echo "  rc=$RC stdout=[$OUT] stderr=[$ERR] log=[$(cat "$STUB_LOG")]" >&2
  exit 1
}

has() { case $1 in *"$2"*) return 0 ;; *) return 1 ;; esac; }

called() { grep -q "^$1 " "$STUB_LOG"; }

RESTART="Restart OpenCode to load the rebuilt plugin."

new_repo
run
[ "$RC" -eq 0 ] || fail "success prints the load action: exit $RC"
has "$OUT" "ok: cursor integration loaded" || fail "success prints the load action: no ok line"
has "$OUT" "$RESTART" || fail "success prints the load action: no restart line"
has "$OUT" "/reload" && fail "success prints the load action: mentions /reload"
called npm || fail "success prints the load action: npm not called"
echo "ok success prints the load action"

new_repo
export STUB_NPM_RC=1
run
[ "$RC" -ne 0 ] || fail "build failure stops before the host call: exit 0"
called npm || fail "build failure stops before the host call: npm not called (anchor)"
called opencode && fail "build failure stops before the host call: opencode was called"
echo "ok build failure stops before the host call"

new_repo
export STUB_OC_MODE=absent
run
[ "$RC" -eq 1 ] || fail "integration absent fails: exit $RC"
has "$ERR" "load-local: cursor integration not found" || fail "integration absent fails: no not-found line"
has "$OUT" "$RESTART" && fail "integration absent fails: printed the restart line"
called opencode || fail "integration absent fails: opencode not called (anchor)"
echo "ok integration absent fails"

new_repo
export STUB_OC_MODE=error
run
[ "$RC" -eq 1 ] || fail "opencode error fails cleanly: exit $RC"
has "$ERR" "load-local: cursor integration not found" || fail "opencode error fails cleanly: no not-found line"
has "$OUT" "$RESTART" && fail "opencode error fails cleanly: printed the restart line"
called opencode || fail "opencode error fails cleanly: opencode not called (anchor)"
echo "ok opencode error fails cleanly"

new_repo
export STUB_OC_MODE=marker
run
[ "$RC" -eq 0 ] || fail "response body is not printed: exit $RC"
has "$OUT" "ok: cursor integration loaded" || fail "response body is not printed: no ok line (anchor)"
has "$OUT" "$MARKER" && fail "response body is not printed: marker on stdout"
has "$ERR" "$MARKER" && fail "response body is not printed: marker on stderr"
echo "ok response body is not printed"

new_repo
run
[ "$RC" -eq 0 ] || fail "nothing is written under HOME: exit $RC"
[ -z "$(ls -A "$HOME")" ] || fail "nothing is written under HOME: $(ls -A "$HOME")"
echo "ok nothing is written under HOME"

new_repo branch
run
[ "$RC" -eq 2 ] || fail "on a feature branch is refused: exit $RC"
has "$ERR" "load-local: HEAD is feat/x, not main" || fail "on a feature branch is refused: no refusal line"
called npm && fail "on a feature branch is refused: npm was called"
called opencode && fail "on a feature branch is refused: opencode was called"
echo "ok on a feature branch is refused"

new_repo detach
run
[ "$RC" -eq 2 ] || fail "detached HEAD is refused: exit $RC"
has "$ERR" "load-local: HEAD is detached, not main" || fail "detached HEAD is refused: no refusal line"
called npm && fail "detached HEAD is refused: npm was called"
echo "ok detached HEAD is refused"
