#!/usr/bin/env bash
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/review-brief.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com

N=0
CHECKS="$TMP/checks.txt"
printf 'tsc: ok\nsmoke: ok\nbuild: ok\n' >"$CHECKS"
REVIEWER=anthropic/claude-opus-5-5
AUTHOR=anthropic/claude-sonnet-5-5
PLAN=.superpowers/plans/2026-10-28-demo.md

# new_repo: sets W to a work repo on feature branch feat/x, one commit ahead of main, with a bare origin holding main.
new_repo() {
  N=$((N + 1))
  W="$TMP/w$N"
  git init -q -b main "$W"
  git init -q --bare -b main "$TMP/r$N.git"
  git -C "$W" remote add origin "$TMP/r$N.git"
  git -C "$W" commit -q --allow-empty -m seed
  git -C "$W" push -q origin main
  git -C "$W" checkout -q -b feat/x
  git -C "$W" commit -q --allow-empty -m work
  REVIEW="$W/.superpowers/review/feat-x"
  mkdir -p "$REVIEW"
}

# run <args>: runs the script inside W; sets OUT, ERR, RC.
run() {
  RC=0
  OUT=$(cd "$W" && bash "$SCRIPT" "$@" 2>"$TMP/err") || RC=$?
  ERR=$(cat "$TMP/err")
}

fail() {
  echo "FAIL $DESC: $1" >&2
  echo "--- stdout" >&2
  echo "$OUT" >&2
  echo "--- stderr" >&2
  echo "$ERR" >&2
  exit 1
}

# passes <desc> <args>: the script exits 0.
passes() {
  DESC=$1
  shift
  run "$@"
  [ "$RC" -eq 0 ] || fail "exit $RC, wanted 0"
}

# refused <desc> <reason> <args>: exit 2 and stderr names the reason.
refused() {
  DESC=$1
  local reason=$2
  shift 2
  run "$@"
  [ "$RC" -eq 2 ] || fail "exit $RC, wanted 2"
  case $ERR in
    "review-brief: "*"$reason"*) ;;
    *) fail "stderr lacks 'review-brief: ...$reason'" ;;
  esac
  echo "ok $DESC"
}

has() {
  case $OUT in
    *"$1"*) ;;
    *) fail "stdout lacks: $1" ;;
  esac
}

lacks() {
  case $OUT in
    *"$1"*) fail "stdout has: $1" ;;
  esac
}

done_case() {
  echo "ok $DESC"
}

STD=(--reviewer "$REVIEWER" --author "$AUTHOR" --checks "$CHECKS")

new_repo
HEAD_SHA=$(git -C "$W" rev-parse HEAD)
BASE_SHA=$(git -C "$W" rev-parse main)
passes "first round" --phase "$PLAN" 4 "${STD[@]}"
has "- **Plan:** \`$PLAN\`, \`## Phase 4\`"
has "- **Base:** \`$BASE_SHA\`"
has "- **Head:** \`$HEAD_SHA\`"
has ".superpowers/review/feat-x/pr-body.md"
has "- **Round:** 1"
has ".superpowers/review/feat-x/round-1.md"
has "- **Reviewer model:** \`$REVIEWER\`, default"
has "- **Author models:** \`$AUTHOR\`"
lacks "Previous report"
lacks "What changed"
lacks "Rulings"
lacks "SDD ledger"
done_case

new_repo
printf 'F1: fixed the thing\n\nF2: renamed the other\n' >"$TMP/changes.txt"
touch "$REVIEW/round-1.md"
passes "round 2 with changes" --phase "$PLAN" 4 "${STD[@]}" --changes "$TMP/changes.txt"
has "- **Round:** 2"
has ".superpowers/review/feat-x/round-2.md"
has "- **Previous report:** \`"
has "round-1.md"
has "- **What changed since round 1:**"
has "  - F1: fixed the thing"
has "  - F2: renamed the other"
done_case

new_repo
touch "$REVIEW/round-1.md"
refused "round 2 without changes is refused" "--changes" --phase "$PLAN" 4 "${STD[@]}"

new_repo
touch "$REVIEW/round-1.md"
refused "changes that is a directory is refused" "--changes" --phase "$PLAN" 4 "${STD[@]}" --changes "$TMP"

new_repo
touch "$REVIEW/round-1.malformed-1.md"
passes "renamed malformed report does not count" --phase "$PLAN" 4 "${STD[@]}"
has "- **Round:** 1"
lacks "Previous report"
done_case

new_repo
passes "no phase" --no-phase "tidy the hooks" "${STD[@]}"
has "- **Plan:** no plan phase: tidy the hooks"
lacks "SDD ledger"
done_case

new_repo
git -C "$W" commit -q --allow-empty -m a -m "body" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git -C "$W" commit -q --allow-empty -m b -m "body" -m "Co-Authored-By: GPT 5 Codex <noreply@openai.com>"
passes "two Co-Authored-By trailers join the authors" --no-phase x --reviewer "$REVIEWER" --author other/model --checks "$CHECKS"
has "- **Author models:** \`other/model,claude-sonnet-5.5,gpt-5-codex\`"
done_case

new_repo
git -C "$W" commit -q --allow-empty -m a -m "body" -m "Co-Authored-By: Human Person <human@example.com>"
passes "a trailer without a noreply address is ignored" --no-phase x "${STD[@]}"
has "- **Author models:** \`$AUTHOR\`"
done_case

new_repo
git -C "$W" commit -q --allow-empty -m a -m "body" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
passes "a trailer naming a listed model adds nothing" --no-phase x "${STD[@]}"
has "- **Author models:** \`$AUTHOR\`"
done_case

new_repo
git -C "$W" checkout -q main
refused "on main is refused" "main" --no-phase x "${STD[@]}"

new_repo
git -C "$W" checkout -q --detach
refused "detached HEAD is refused" "detached" --no-phase x "${STD[@]}"

new_repo
refused "author with shell metacharacters is refused" "author" --no-phase x --reviewer "$REVIEWER" --author 'a;rm -rf x' --checks "$CHECKS"

new_repo
refused "missing checks is refused" "checks" --no-phase x --reviewer "$REVIEWER" --author "$AUTHOR" --checks "$TMP/nope.txt"

new_repo
refused "non-numeric phase is refused" "phase number" --phase "$PLAN" four "${STD[@]}"

new_repo
mkdir -p "$W/.superpowers/sdd/2026-10-28-demo"
passes "ledger line printed when the sdd dir exists" --phase "$PLAN" 4 "${STD[@]}"
has "- **SDD ledger:** \`"
has ".superpowers/sdd/2026-10-28-demo/"
done_case

new_repo
passes "override marker" --no-phase x "${STD[@]}" --override
has "- **Reviewer model:** \`$REVIEWER\`, owner override"
done_case

new_repo
touch "$REVIEW/rulings.md"
passes "rulings line printed when rulings.md exists" --no-phase x "${STD[@]}"
has "- **Rulings:** \`"
has ".superpowers/review/feat-x/rulings.md"
done_case

new_repo
passes "check results printed in a fenced block" --no-phase x "${STD[@]}"
has "- **Check results:**
\`\`\`
tsc: ok
smoke: ok
build: ok
\`\`\`"
done_case

new_repo
printf 'x' >"$TMP/nonl.txt"
passes "checks without a trailing newline keep the fence closed" --no-phase x --reviewer "$REVIEWER" --author "$AUTHOR" --checks "$TMP/nonl.txt"
has "- **Check results:**
\`\`\`
x
\`\`\`
- **Reviewer model:**"
done_case

new_repo
printf '%s\n' '```' >"$TMP/ticks.txt"
passes "a fence in the checks lengthens the block fence" --no-phase x --reviewer "$REVIEWER" --author "$AUTHOR" --checks "$TMP/ticks.txt"
has "- **Check results:**
\`\`\`\`
\`\`\`
\`\`\`\`
- **Reviewer model:**"
done_case

new_repo
refused "checks that is a directory is refused" "checks" --no-phase x --reviewer "$REVIEWER" --author "$AUTHOR" --checks "$TMP"

new_repo
git -C "$W" update-ref -d refs/remotes/origin/main
refused "no origin/main is refused" "origin/main" --no-phase x "${STD[@]}"

new_repo
: >"$TMP/empty.txt"
refused "empty checks file is refused" "checks" --no-phase x --reviewer "$REVIEWER" --author "$AUTHOR" --checks "$TMP/empty.txt"

new_repo
refused "malformed reviewer is refused" "reviewer" --no-phase x --reviewer 'bad model' --author "$AUTHOR" --checks "$CHECKS"
