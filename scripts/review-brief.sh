#!/usr/bin/env bash
# Prints the brief that /review-phase sends to phase-reviewer, with every sha, path and the round
# read from git and the review's directory, so no one types them. The brief's fields are those of
# .opencode/agents/phase-reviewer.md; the print is the whole prompt of the dispatch.
#
# Usage:
#   review-brief.sh --phase <plan path> <phase number> <options>
#   review-brief.sh --no-phase <one sentence stating the branch's purpose> <options>
# Options, in any order: --reviewer <model>, --author <models> and --checks <file> (all required; the
# author is one model or several joined by `,`; the brief adds every model a Co-Authored-By trailer of
# base..head credits with a noreply@ address; the checks file holds the controlling session's results
# of the three repo checks), --override (the reviewer model is the owner's, not the default),
# --changes <file>.
#
# Base is the merge base of origin/main and HEAD; head is HEAD's full sha. The round is one more than
# the highest `round-<n>.md` in <top>/.superpowers/review/<branch>/ (a report renamed
# `round-<n>.malformed-<k>.md` does not count), or 1. From round 2 on, --changes names a file with one
# line per previous finding, `<id>: <what changed>`, and the script refuses to print without it.
#
# Exit 0: the brief is on stdout. Exit 2: a wrong argument, a missing or malformed model, a missing or
# empty checks file, a detached HEAD, HEAD on main, no origin/main, or a round 2 or later with no
# usable --changes file.

# The backticks in the printf formats are Markdown, printed as they stand.
# shellcheck disable=SC2016
set -euo pipefail

die() {
  echo "review-brief: $1" >&2
  exit 2
}

plan_field=''
changes=''
checks=''
reviewer=''
author=''
marker='default'
case ${1:-} in
  --phase)
    (($# >= 3)) || die 'usage: --phase <plan path> <phase number>'
    [[ $3 =~ ^[0-9]+$ ]] || die "the phase number is not a whole number: $3"
    plan=$2
    plan_field="\`$2\`, \`## Phase $3\`"
    shift 3
    ;;
  --no-phase)
    (($# >= 2)) || die 'usage: --no-phase <one sentence>'
    plan=''
    plan_field="no plan phase: $2"
    shift 2
    ;;
  *) die 'usage: --phase <plan path> <phase number> | --no-phase <one sentence>, then --reviewer <model> --author <models> --checks <file> [--override] [--changes <file>]' ;;
esac
while (($# > 0)); do
  case $1 in
    --override)
      marker='owner override'
      shift
      ;;
    --reviewer | --author | --checks | --changes)
      (($# >= 2)) || die "$1 needs a value"
      case $1 in
        --reviewer) reviewer=$2 ;;
        --author) author=$2 ;;
        --checks) checks=$2 ;;
        --changes) changes=$2 ;;
      esac
      shift 2
      ;;
    *) die "unknown arguments: $*" ;;
  esac
done
model='[A-Za-z0-9][A-Za-z0-9._/#-]*'
[[ -n $reviewer ]] || die 'a brief needs --reviewer <model>'
[[ -n $author ]] || die 'a brief needs --author <models>'
[[ -n $checks ]] || die 'a brief needs --checks <file>'
[[ $reviewer =~ ^$model$ ]] || die "the reviewer is not a valid model: $reviewer"
[[ $author =~ ^$model(,$model)*$ ]] || die "the author is not a valid model (list): $author"
[[ -s $checks ]] || die "the --checks file is missing or empty: $checks"

top=$(git rev-parse --show-toplevel) || die 'not inside a git repository'
branch=$(git symbolic-ref --short -q HEAD) || die 'HEAD is detached'
[[ $branch != main ]] || die 'HEAD is on main: review a feature branch'
base=$(git merge-base origin/main HEAD 2>/dev/null) || die 'git cannot find a merge base of origin/main and HEAD'
head=$(git rev-parse HEAD)
review="$top/.superpowers/review/${branch//\//-}"

last=0
for report in "$review"/round-*.md; do
  [[ -e $report ]] || continue
  name=${report##*/}
  [[ $name =~ ^round-([0-9]+)\.md$ ]] || continue
  if ((BASH_REMATCH[1] > last)); then
    last=${BASH_REMATCH[1]}
  fi
done
round=$((last + 1))

if ((round > 1)); then
  [[ -n $changes ]] || die "round $round needs --changes <file>: one line per previous finding, '<id>: <what changed>'"
  [[ -s $changes ]] || die "the --changes file is missing or empty: $changes"
fi

# Two models are the same when their keys match: lowercase, up to the last `/` removed, `.` as `-`.
model_key() {
  local key
  key=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  key=${key##*/}
  printf '%s' "${key//./-}"
}
trailers=$(git log --reverse --format='%(trailers:key=Co-authored-by,valueonly,unfold)' "$base..$head") || die "git cannot read the history of $base..$head"
# Every model a noreply Co-Authored-By trailer of base..head credits joins the list, first seen first.
while IFS= read -r trailer; do
  [[ -n $trailer && $trailer == *'<'*'>' ]] || continue
  address=$(printf '%s' "${trailer##*<}" | tr '[:upper:]' '[:lower:]')
  [[ $address == noreply@* ]] || continue
  credited=$(printf '%s' "${trailer%%<*}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9.]+/-/g; s/^[^a-z0-9]+//; s/-+$//')
  [[ -n $credited ]] || continue
  seen=''
  IFS=, read -ra listed <<<"$author"
  for entry in "${listed[@]}"; do
    [[ $(model_key "$entry") == "$(model_key "$credited")" ]] && seen=1
  done
  [[ -n $seen ]] || author="$author,$credited"
done <<<"$trailers"

# The fence is longer than any backtick run in the checks, so their output cannot close it.
fence='```'
while grep -qF "$fence" "$checks"; do
  fence="$fence\`"
done

printf '%s\n' '## Phase review brief' ''
printf -- '- **Plan:** %s\n' "$plan_field"
printf -- '- **Base:** `%s`\n' "$base"
printf -- '- **Head:** `%s`\n' "$head"
printf -- '- **PR draft:** `%s/pr-body.md`\n' "$review"
printf -- '- **Round:** %s\n' "$round"
printf -- '- **Report:** `%s/round-%s.md`\n' "$review" "$round"
printf -- '- **Check results:**\n%s\n' "$fence"
cat "$checks"
printf '%s\n' "$fence"
printf -- '- **Reviewer model:** `%s`, %s\n' "$reviewer" "$marker"
printf -- '- **Author models:** `%s`\n' "$author"
if ((round > 1)); then
  printf -- '- **Previous report:** `%s/round-%s.md`\n' "$review" "$last"
  printf -- '- **What changed since round %s:**\n' "$last"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -n $line ]] && printf '  - %s\n' "$line"
  done <"$changes"
fi
if [[ -e $review/rulings.md ]]; then
  printf -- '- **Rulings:** `%s/rulings.md`\n' "$review"
fi
if [[ -n $plan ]]; then
  ledger="$top/.superpowers/sdd/$(basename "$plan" .md)"
  if [[ -d $ledger ]]; then
    printf -- '- **SDD ledger:** `%s/`\n' "$ledger"
  fi
fi
exit 0
