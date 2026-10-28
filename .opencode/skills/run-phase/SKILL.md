---
name: Run Phase
description: Build one phase of an approved implementation plan through subagent-driven-development, on its phase branch in the project checkout, and stop at the code review gate. Only the owner starts it, with /run-phase. It asks once to confirm the task list and models, stops again only at the stops below, writes the PR draft and hands over to /review-phase.
---

# Phase runner

Build one phase of a plan through the `subagent-driven-development` skill (SDD) and stop at the code review gate. This session is SDD's controller: it dispatches a builder and a task reviewer per task, keeps SDD's ledger, and brings to the owner the points SDD would otherwise rule on alone. It ends with the PR draft written and the next command, `/review-phase`, named.

`$ARGUMENTS` is `<plan> [phase]`. A plan without `## Phase` sections is phase 1, so the phase may be omitted for it; a plan with phase sections and no phase: ask the owner which one.

Only the owner starts this skill, with the `/run-phase` command. A model that was not told by the owner to run a phase stops.

## Where things are

- `<top>` is `git rev-parse --show-toplevel`.
- `<name>` is the plan's file name without `.md` and without its leading `YYYY-MM-DD-`: `workflow` for `2026-10-28-workflow.md`.
- The phase branch is `feat/<name>-p<phase>-<slug>`. `<slug>` is a few words of the phase title in kebab case and matches `^[a-z0-9-]+$`.
- `<branch-dir>` is the branch with `/` replaced by `-`. The PR draft is `<top>/.superpowers/review/<branch-dir>/pr-body.md`, in the shape of `pr-template.md` (in this skill's directory).
- SDD's workspace is the directory SDD's `sdd-workspace` script prints (`bash scripts/sdd-workspace PLAN_FILE`, run from SDD's own skill directory): `<top>/.superpowers/sdd/<plan basename without .md>/`. It holds the ledger `progress.md`, the task briefs, the builders' reports and the review packages. It is git-ignored and outlives every phase of the plan.

## 1 Preconditions

In order. Stop at the first that fails, say which, and name the fix. A precondition failure only prints its message and ends: `question` is used from step 2 onward, never here.

1. **The plan resolves.** Exactly one file under `.superpowers/plans/` has a name that contains the argument, or the argument is that path. None or several: list the candidates.
2. **The phase is open.** The plan has a heading `## Phase <n>` followed by a space, `:` or the end of the line (`Phase 1` must not match `Phase 10`), and it carries no `✅ DONE`.
3. **`bun` works.** A plain `bun --version` shell call, with no `export PATH` in it, succeeds. If it fails but the scratch install `/private/var/folders/fb/48x5_64j39x4bj4j2b_y5bvh0000gn/T/opencode/bunbin/node_modules/.bin` exists, stop (print the message, no `question`) and name the two remedies: put `bun` on the PATH opencode starts with, or tell this session that the controller runs the smoke test per head.
   - On the second remedy, the session records `Owner ruling: controller runs smoke` in the ledger (when the ledger does not exist yet, right after SDD's setup and the `Phase <n> confirmed:` line) and the controller's shell uses the scratch PATH.
   - On every later run this precondition passes while that ruling is held in this session or in the plan's ledger and the scratch directory exists. Builder briefs then say not to report BLOCKED for a missing `bun`: the controller runs `bun test/smoke.ts` on each head.
   - If `bun` exists nowhere: stop.
4. **The plan is approved.** Review directories are `.superpowers/review-plan/<plan basename>-<suffix>/`. One covers the phase when its suffix is `all`, or when its `+`-separated elements include the phase number as a whole element (`3+4` covers 3; `10+11` does not cover 1). Take the highest `round-<n>.md` of each covering directory: its last line must be `**Verdict: Approved**`.
   - More than one covering directory: stop and list them for the owner to name.
   - No report, or Not approved: stop, unless the owner says in chat to skip the review. Record that as `Owner ruling: review-plan skipped`.
5. **Git state.** Read the branch with `git symbolic-ref -q HEAD` and the tree with `git status --porcelain`.
   - On `main` with a clean tree: list `git branch --list 'feat/<name>-p<phase>-*'`. One: switch to it with `git switch`. None: create it with `git switch -c` after step 2, and the confirmation shows its name. More than one: stop and list them.
   - Already on a branch `feat/<name>-p<phase>-*`: continue.
   - Anywhere else, or a dirty tree: stop and name the remedy (commit or stash, or switch to `main` or to the phase branch).
6. **The hooks are active.** `git config core.hooksPath`, as a shell call of its own, prints exactly `.githooks`. Anything else: stop and name the fix, `git config core.hooksPath .githooks`.

## 2 Confirm once

Read the phase and print:

- one row per unticked task (a `### Task` with a `- [ ]` step): its title, its files, and the deferred minors carried into it;
- the branch the run uses or will create;
- the owner's hands: anything only the owner can do (a key, an owner-led step, a run on another machine);
- the builder and reviewer models: the `model` of `.opencode/agents/phase-builder.md` and `.opencode/agents/task-reviewer.md`.

Then ask one question with the `question` tool: run as shown, or change it (reorder, drop or split rows, or name a model for a role from that role's allowed list in `AGENTS.md`). A model outside the list is refused and the question is asked again. Apply the answer and create the branch if step 1.5 found none. After this, nothing is asked until a stop of step 4.

## 3 Run SDD on those tasks only

Load `subagent-driven-development` with the `skill` tool and run it on the plan under this run contract. Where SDD's text and the contract differ, the contract binds.

- **Scope:** the confirmed tasks, in the confirmed order. Tasks of other phases and dropped rows are never dispatched. The first ledger line after SDD's setup is `Phase <n> confirmed: <tasks>; builder model: <m>; reviewer model: <m>`. Never write the ledger before SDD's setup has created or verified it.
- **No worktree:** the phase branch in this checkout replaces SDD's worktree step. SDD's scripts, run from SDD's own skill directory, do the bookkeeping: `bash scripts/task-brief PLAN_FILE N` writes a task brief and `bash scripts/review-package PLAN_FILE BASE HEAD` writes the review diff.
- **Dispatches** use the `subagent` tool. Every builder, fixer and resume goes to `phase-builder`; every task review and re-review goes to `task-reviewer`. Pass `model` only on an owner override; otherwise the agent file's model applies. A missing named agent is a stop (a fresh session), never a fallback to `general`.
- **Builder brief.** It carries, spelled literally:
  - Task brief path;
  - Branch;
  - Dispatcher's session id, read with `printenv OPENCODE_SESSION_ID` as a call of its own;
  - Model name for the `Co-Authored-By` trailer, exact (for example `Claude Sonnet 5.5`);
  - the trailer key `Agent-Session`, spelled exactly like that;
  - the commit-message restrictions, copied verbatim from `.opencode/agents/phase-builder.md` ("Commit messages stay plain");
  - the report file path;
  - the `bun` ruling, if one applies (not to report BLOCKED for `bun`).
- **Outside material.** Reference material outside the repo is copied under `.superpowers/ref/` first: builders cannot read outside the project and cannot use `webfetch`.
- **After every builder return:**
  1. `git log <base>..HEAD "--format=%h %(trailers:only)"` must show `Co-Authored-By` and `Agent-Session` for every new commit. Missing on the latest commit: resume the builder to amend it. Missing on an earlier commit: stop and tell the owner.
  2. The controller runs `npx tsc -p tsconfig.json --noEmit`, `bun test/smoke.ts` and `npm run build` on the head and puts the results in the task-reviewer brief. Reviewers run no scripts.
- **Reviewer constraints:** the plan's Global Constraints verbatim, plus the section of each check of `.opencode/skills/review-plan/contract.md` that the task triggers.
- **Red evidence:** each builder report names, per new behaviour, the test it watched fail and the failing line. A missing one is a spec gap. Agent or skill prose and pure config are exempt and say so.
- **The controller commits nothing.** Only builders commit code.

## 4 Stops

SDD's four stay: an irreversible or destructive operation; a security-sensitive action; a side effect outside this checkout that norms say to ask about first; a plan so broken that every path forward is a guess. On top of them:

- a point that touches contract check 2 or check 3;
- a point that changes the spec;
- a point that rests on an outside fact;
- a builder reporting BLOCKED;
- a task's fix loop that survives three resumes;
- any refused dispatch (quota included);
- a missing named agent (needs a fresh session).

SDD's "Rulings, not stalls" never covers these. This session does not rule on them. It asks the owner with the `question` tool, recommendation first, records `Owner ruling: <point> — <answer>` in the ledger, and passes the answer to the same builder (resumed with `sessionID`) or, when there is none to resume, to a fresh `phase-builder`. NEEDS_CONTEXT stays SDD's: supply the context and re-dispatch. SDD rules on every other point itself and records `Ruling: …`.

## 5 End at the gate

When the last confirmed task has its `Task <N>: complete` line:

- **Not run:** SDD's final whole-branch review, the deletion of its workspace, and `finishing-a-development-branch`. `/review-phase` replaces the review and the finishing step, and the workspace is kept.
- **Run:** SDD's "Rulings I made" collection: every ledger `Ruling:` line, with the `Owner ruling:` lines beside it.
- **Write the PR draft** at `<top>/.superpowers/review/<branch-dir>/pr-body.md` from `pr-template.md`, creating the directory. A draft that exists is added to, never overwritten. Fill it from the ledger and the builders' reports:
  - *Review-plan verdict:* the latest report covering the phase;
  - *Task coverage:* each task, where it lands, its tests;
  - *Red evidence:* per behaviour, the test and its failing line;
  - *Deviations:* every change outside the phase's text, or "none";
  - *Executor-level decisions:* each with why;
  - *Rulings:* "Rulings I made" and the owner's rulings;
  - *Verification:* the checks of each task;
  - *Deferred findings:* every `Task <N>: minor (deferred)` ledger line.

  Leave *Code-review verdict* empty: `/review-phase` fills it.
- **Print the summary:** the tasks with their commits, the rulings, the deferred findings, and the next command, `/review-phase`.

## 6 Re-invocation

`/run-phase` on a partly built phase resumes. The preconditions run again, the skill shows the remaining list, asks the one question again, appends a second `Phase <n> confirmed:` line and resumes at the first confirmed task with no `Task <N>: complete` line.

## Never

- Write the DONE marker: only `/review-phase` writes it.
- Open a pull request.
- Push.
- Commit.
