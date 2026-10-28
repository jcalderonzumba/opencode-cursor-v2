---
name: Review Phase
description: Review a branch's diff before its pull request opens. The session that built the phase runs the clerk's sections (Where things are to Landing) to check preconditions, run the checks, send `phase-reviewer` a brief and open the PR on approval, and never reviews inline; `phase-reviewer` runs Phases 0 to 4 in a fresh context.
---

# Phase review gate

Review the diff of one phase of a plan, or of a branch with no plan phase, in five phases, in order, before its pull request opens. The review runs in a fresh context: the session that built the phase is the clerk, dispatches `phase-reviewer` ([Dispatch](#3-dispatch)) and runs none of Phases 0 to 4. When you are `phase-reviewer`, the sections from [Where things are](#where-things-are) on are not yours: review the diff your brief names through every phase, and write the report Phase 4 describes.

## Severities

- **Must Fix**: blocks approval; a correctness, security or contract issue.
- **Should Fix**: a recommended improvement or a missed best practice.
- **Consider**: optional, minor.

Every phase and every check runs in every round, so one round reports every finding and one revision fixes them all: a Must Fix blocks approval, never the checks after it. A skill that is unavailable is listed as skipped and the review continues. Every skip appears in the summary with its reason.

## Phase 0: The contract

Apply every check of `.opencode/skills/review-plan/contract.md` with its trigger, to the diff `<base>..<head>`. Its two rules, **Decisions win** and **Every check runs**, override every skill invoked below. For spec conformance, read the spec the plan cites and check the diff against its decisions. Read the PR draft's Deviations and Verification sections: a deviation stated there is judged for its justification, one the diff shows and the draft does not state is a finding, and a claim the change depends on needs the live verification the draft records. A check whose trigger does not fire is listed as skipped, with its reason.

## Phase 1: Contract with the plan and `AGENTS.md`

1. **The phase landed as planned.** Every task of the phase under review (or the stated purpose, for `no plan phase`) is present in the diff, and every change outside the phase's text is declared in the PR draft's Deviations. **Must Fix**: a planned task missing or only partly landed, or an undeclared deviation.
2. **Trailers.** Every commit of `<base>..<head>` carries a `Co-Authored-By` and an `Agent-Session` trailer: `git log <base>..<head> "--format=%h %(trailers:only)"`. **Must Fix**: a commit without either.
3. **Session independence.** Each commit's `Agent-Session` differs from the dispatcher's session id, read from the `Dispatcher's session id: <id>` line in the ledger's `progress.md`, beside the `Phase <n> confirmed:` line. **Must Fix**: a commit that carries the dispatcher's id (the controller committed).

Check 3 is skipped, with that reason, when the brief names no SDD ledger, as it does for `no plan phase`, or when `progress.md` has no `Dispatcher's session id:` line. Checks 1 and 2 run for every branch.

## Phase 2: Craft

Load `uncle-bob-craft` with the `skill` tool and judge the diff against it, with Phase 0 and Phase 1 findings as context. Unavailable: list it as skipped.

## Phase 3: Skills by diff path

Load each skill the diff paths call for with the `skill` tool and judge the diff against it:

- `src/proxy.ts`, `src/h2-bridge.mjs`, `src/auth.ts`, `src/native-tools.ts`, `src/v2.ts`: `api-security-best-practices` and `backend-security-coder`.
- `test/**`: `test-driven-development`.
- Docs only: none.

A skill that does not apply to the diff is listed as skipped, with its reason.

## Phase 4: The report

`phase-reviewer` writes one report with the `write` tool to the path its brief names, once. Its parts, in order:

1. A title: `Phase review, round <n>: <branch>`.
2. The header lines of `phase-reviewer`'s "The models": **Reviewer model** (`<model>`, `default` or `owner override`), **Author models**, **Same vendor** (`yes`, `no` or `unknown`).
3. `Previous findings` (round 2 and later): a table of id, status (resolved, deferred or unresolved) and evidence.
4. One section per phase, 0 to 3, holding that phase's findings.
5. A summary: the ids by severity, every skipped check or skill with its reason, and what the reviewer believed but did not verify.
6. The verdict as the last line, exactly one of these two:

```text
**Verdict: Approved**
**Verdict: Not approved** — <n> Must Fix: <ids>
```

Approved means no Must Fix in any section.

Finding ids are `R<round>-M<n>` (Must Fix), `R<round>-S<n>` (Should Fix) and `R<round>-C<n>` (Consider), numbered from 1 in each round. A finding names its place (file and line at the head, or the PR draft section), what is wrong, the evidence and the fix.

---

Everything below is the clerk's. `phase-reviewer` does not own it.

## Where things are

`$ARGUMENTS` is `[--model <m>] [--no-phase "<purpose>"]`.

- `<top>` is `git rev-parse --show-toplevel`.
- `<branch>` is the current branch, `git symbolic-ref -q --short HEAD`, and `<branch-dir>` is `<branch>` with every `/` replaced by `-`.
- The review's directory is `<top>/.superpowers/review/<branch-dir>/`, git-ignored. It holds the PR draft `pr-body.md`, the check results `checks.txt`, each round's report `round-<n>.md`, the changes file for the next brief, and the owner's rulings `rulings.md`.
- **What is reviewed.** A plan phase branch is `feat/<name>-p<phase>-<slug>`: the phase is `<phase>`, and the plan is the one file under `.superpowers/plans/` whose name ends `<name>.md`. When the branch does not fit that form, or none or several files match, ask the owner. `--no-phase "<purpose>"` reviews a branch with no plan phase, with that one sentence stating its purpose (given twice, or without a sentence: stop, naming it).
- The SDD ledger is `<top>/.superpowers/sdd/<plan basename without .md>/`, with `progress.md` and the task briefs. A `--no-phase` review has none.
- The base is `git merge-base origin/main HEAD` and the head is `HEAD`'s full sha.

## 1 Preconditions

In order. Stop at the first that fails, say which, and say what fixes it. A stopping clerk repairs nothing.

0. **The arguments.** `--model <m>` is accepted only when `<m>` is in the reviewer list of `AGENTS.md` ("Roles and models") and matches `^[a-z0-9-]+/[A-Za-z0-9._-]+(#[A-Za-z0-9._-]+)?$`. A value that is not in the reviewer list, or that does not match that regex, or is given twice, or without a value, or as any other token, is a stop: print the offending value and end with nothing else. Do not run preconditions 1 to 8, write a file, or dispatch. (`openai/gpt-x` is a stop: not in the list. A value containing a space or `;` is a stop: it fails the regex.) `--no-phase` given twice, or without a sentence, is a stop in the same way.
1. **A clean tree:** `git status --porcelain` prints nothing.
2. **Not on `main`:** the branch is not `main`.
3. **Not behind or diverged from its upstream.** Run `git fetch origin`. When the branch has an upstream (`git rev-parse --abbrev-ref '@{upstream}'` answers), `git rev-list --left-right --count 'HEAD...@{upstream}'` prints `<ahead> <behind>`. Behind only, or diverged: stop and tell the owner, who chooses. This skill never force-pushes. With no upstream, or not behind, go on.
4. **`bun` works,** as in `/run-phase` precondition 3: a plain `bun --version` shell call succeeds. When it fails, the ruling `controller runs smoke` (the clerk runs `bun test/smoke.ts` on each head with the scratch PATH) may stand: for a plan phase it is the `Owner ruling: controller runs smoke` line of the ledger; for `--no-phase`, which has no ledger, it is held in chat and asked again each run. Without the ruling, stop and name the two remedies of `/run-phase`.
5. **The PR draft exists** at `<top>/.superpowers/review/<branch-dir>/pr-body.md`. When it does not, create the directory, write the draft from `.opencode/skills/run-phase/pr-template.md` (Variant A for a plan phase, Variant B for `--no-phase`), and STOP: print the draft path and end with nothing else — do not generate a brief or dispatch. The clerk fills the draft and reports before the next run.
6. **The three checks pass on `HEAD` now.** The clerk runs `npx tsc -p tsconfig.json --noEmit`, `bun test/smoke.ts` and `npm run build`, one command per call, and writes each command with its result to `<top>/.superpowers/review/<branch-dir>/checks.txt`. A red check is a stop; the fix goes through [the loop](#4-the-loop).
7. **For a plan phase, every confirmed task is complete:** each task of the ledger's `Phase <n> confirmed:` line has a `Task <n>: complete` line.
8. **The public-repo check.** `git log --name-only --format= origin/main..HEAD` lists no path under `.superpowers/` or `docs/superpowers/`. This reads history, not just the tree. A hit is a stop for the owner.

## 2 Checks and brief

**The model.** `--model <m>` was validated in precondition 0. With no `--model`, the reviewer model is the `model` of `.opencode/agents/phase-reviewer.md` and the dispatch passes none. Every round uses the same reviewer model and marker; from round 2 read them from the previous report's header.

**The author.** The distinct `builder model:` values of the ledger's `Phase <n> confirmed:` lines, joined by `,`; `unknown` when there are none; the clerk's own model for `--no-phase`. The script adds every model a `Co-Authored-By` trailer of the range credits.

**The brief.** Run the script as a command of its own, `<top>` written out, and use its output as the dispatch prompt, copied as printed:

```bash
bash <top>/scripts/review-brief.sh --phase <plan path> <phase> --reviewer <model> --author <models> --checks <top>/.superpowers/review/<branch-dir>/checks.txt [--override]
bash <top>/scripts/review-brief.sh --no-phase "<purpose>" --reviewer <model> --author <models> --checks <top>/.superpowers/review/<branch-dir>/checks.txt [--override]
```

`--override` is passed only with `--model`. From round 2 on add `--changes <file>`: one line per previous finding, `<id>: <what changed>` (fixed, deferred with the reason, or ruled on by the owner). The script refuses to print a later round without it. The clerk prints the brief before dispatching, so the owner sees what the reviewer got.

## 3 Dispatch

Use the `subagent` tool: agent `phase-reviewer`, in the background, the brief as the prompt, `model` only on an owner override. Never a fork, `general` or any other agent, and never an inline review. If `phase-reviewer` is not available, or the dispatch is refused (quota included), stop and tell the owner: a fresh session for a missing agent, the quota for a refusal. Nothing is pushed yet: the reviewer reads the local head. Leave the tree and `HEAD` unchanged while it runs.

Its answer is two lines, the verdict line and the report path. Read the report there.

- **`No review: …`:** the brief lacked a field or the report path is unusable. Fix the brief and dispatch the same round again. When the reason is that a file already exists at the report path, the round has finished: read that report and do not dispatch again.
- **A second line `report not written: …`:** the round left no record, so its verdict counts for nothing. Have the owner resolve the refusal, rename any file left at the report path to `round-<n>.malformed-<k>.md`, and dispatch the same round again.
- **Anything else,** BLOCKED included: the round gave no verdict. Stop and tell the owner.

A report with no verdict line is malformed: rename it as above and dispatch the same round again.

## 4 The loop

Every fix, whether a Not-approved round asks for it or the owner approves one after an approval, is made by `phase-builder`, never by the clerk: resumed by its `sessionID` from the ledger when known, otherwise a fresh dispatch carrying the findings. It works test first when behaviour changes.

On **Not approved**:

- Fix every Must Fix.
- Fix or defer each Should Fix. A deferral is written in the PR draft's Deferred findings with a reason.
- List each Consider in the PR draft's Deferred findings.
- After each fix the clerk runs the three checks on the new head and rewrites `checks.txt`, and `task-reviewer` does a scoped re-review of the fix. Then write the changes file and dispatch the next round from step 2, on the new head.
- **At most 3 rounds.** After round 3, or any later round, with Must Fix findings open, they go to the owner, who decides another round or how they are settled. Append the decision to `rulings.md` as `- After round <n> (owner's decision): <decision> (<YYYY-MM-DD>)`.

## 5 Disputes

A finding the clerk believes is wrong is neither fixed nor silently ignored. It goes to the owner with both readings, the clerk's recommendation first. Append the owner's ruling to `<top>/.superpowers/review/<branch-dir>/rulings.md` (create it if absent) as `- <finding id>: <ruling> (<YYYY-MM-DD>)`. The next brief names the file. A ruling that changes a spec updates the spec in `.superpowers/specs/` (git-ignored, never committed) and is recorded in the PR draft's Rulings. Only the owner rules on a dispute.

## 6 On approval

There is no stamp: the report's last line is the record.

1. **The state held.** `git rev-parse HEAD` equals the brief's head and `git status --porcelain` prints nothing. Otherwise the approval is void: put the state back, or have `phase-builder` commit the change through [the loop](#4-the-loop) and run the next round.
2. **The public-repo check, again on this head.** `git log --name-only --format= origin/main..HEAD` lists no path under `.superpowers/` or `docs/superpowers/`. Fix commits of later rounds are in this range too. A hit is a stop for the owner, and nothing is pushed.
3. **Fill the PR draft's Code-review verdict:** the verdict, the reviewed head sha, the round count, the reviewer model and the report file name. Add the checks of `checks.txt` to Verification, keeping what is already there.
4. **Ask once, then stop.** Show the owner the branch, the sha and the PR body, and ask with the `question` tool: push the branch and open the PR as shown? Only an explicit **yes** counts. Any other answer — no, cancelled, unanswered, an error, or a non-interactive "continue without an answer" — is a stop, and nothing is pushed. The On-approval flow ends here: the clerk does not push from this answer, and runs no push or pull-request command.
5. **The owner pushes, never this session.** The push, the PR, the head check and the DONE marker happen only on the owner's explicit word in a separate turn, like "land pr". When the owner says push: `git push -u origin HEAD`, then `gh pr create -R jcalderonzumba/opencode-cursor-v2 --base main --head <branch> --title "<plain words>" --body-file <top>/.superpowers/review/<branch-dir>/pr-body.md`; then `gh pr view <n> -R jcalderonzumba/opencode-cursor-v2 --json headRefOid` must equal the reviewed sha; last, for a plan phase only (not `--no-phase`), append ` — ✅ DONE (PR #<n>)` to the phase's `## Phase <n>` heading. A refusal or a mismatch is a stop for the owner. A step that failed before the PR opened leaves no marker.

## 7 Landing

The owner's word "land pr" starts it; the clerk never lands on its own. Load the `land-pr` skill and merge with `gh pr merge <n> -R jcalderonzumba/opencode-cursor-v2 --squash --match-head-commit <reviewed sha> --delete-branch`. Then sync the local `main` (`git switch main`, `git pull --ff-only`) and delete the local branch.
