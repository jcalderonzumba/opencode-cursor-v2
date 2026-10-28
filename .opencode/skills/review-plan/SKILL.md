---
name: Review Plan
description: Review an implementation plan, or some of its phases, before any of it is built. The session that wrote the plan runs Dispatch, Rounds and Disputes to send `plan-reviewer` a brief and never reviews inline; `plan-reviewer` runs Phases 0 to 3 in a fresh context.
---

# Plan review gate

Review a plan, or one or more of its `## Phase N` sections, in four phases, in order. The review runs in a fresh context: the session that wrote the plan dispatches `plan-reviewer` ([Dispatch](#dispatch)) and runs none of Phases 0 to 3. When you are `plan-reviewer`, Dispatch, Rounds and Disputes are not yours: review the part your brief names through every phase, and write the report Phase 3 describes.

## Severities

- **Must Fix**: blocks approval; a structural or correctness issue.
- **Should Fix**: a recommended improvement or a missed best practice.
- **Consider**: optional, minor.

Every phase and every check runs in every round, so one round reports every finding and one revision fixes them all: a Must Fix blocks approval, never the checks after it. A skill that is unavailable is listed as skipped and the review continues. Every skip appears in the summary with its reason.

## Phase 0: The contract

Apply every check of `contract.md` (in this skill's directory) with its trigger. Its two rules, **Decisions win** and **Every check runs**, override every skill invoked below. For spec conformance, read the spec the plan cites and check the plan against its decisions. A check whose trigger does not fire is listed as skipped, with its reason.

## Phase 1: Plan vs code reality

Check the plan against the code as it is. Use the `codegraph` CLI (`explore`, `callers`, `impact`, `affected`) when `.codegraph/` exists at the repo root, otherwise the `grep` and `read` tools. A symbol the index does not hold is checked by reading the code, and the report says so.

1. **Named things exist as stated.** Every file, symbol, signature and caller the plan names. **Must Fix**: a task built on one that does not exist or differs.
2. **Callers.** For each existing symbol the plan changes, most callers first, list its callers. A symbol left unchecked is named in the summary as not checked, with the reason. **Must Fix**: a caller of a changed contract that no task or test covers, including a task that claims a green suite while a caller sits in a file a later task owns.
3. **Scope.** When the plan states a scope (a file count or a file list), compare it with the files the changes reach. **Must Fix**: reality is more than twice the stated scope. **Should Fix**: 1.5 to 2 times.

Skipped, with the reason, when the plan only adds files that call nothing existing.

## Phase 2: Qualitative skill review

Load each skill with the `skill` tool and judge the plan against it, with Phase 0 and Phase 1 findings as context.

- **Always:** `concise-planning`, `code-review-checklist`, `kaizen`, `typescript-expert`, `nodejs-best-practices`, `test-driven-development`, `lint-and-validate`.
- **Conditional:** `api-security-best-practices` and `backend-security-coder` when contract check 2 fires; `api-patterns` for a new HTTP surface; `systematic-debugging` for a fix.

## Phase 3: The report

`plan-reviewer` writes one report with the `write` tool to the path its brief names. Its parts, in order:

1. A title: `Plan review, round <n>: <plan path>, <part reviewed>`.
2. The header lines: **Reviewer model** (`<model>`, `default` or `owner override`), **Author model**, **Same vendor** (`yes`, `no` or `unknown`, as `plan-reviewer` defines it), **Inputs** (specs read, previous report, rulings file, or none), **Rulings applied**.
3. `Previous findings` (round 2 and later): a table of id, status (resolved, deferred or unresolved) and evidence.
4. One section per phase, 0 to 2, holding that phase's findings.
5. A summary: the ids by severity, every skipped check or skill with its reason, and what the reviewer believed but did not verify.
6. The verdict as the last line, exactly one of these two:

```text
**Verdict: Approved**
**Verdict: Not approved** — <n> Must Fix: <ids>
```

Approved means no Must Fix in any section.

Finding ids are `R<round>-M<n>` (Must Fix), `R<round>-S<n>` (Should Fix) and `R<round>-C<n>` (Consider), numbered from 1 in each round. A finding names its place in the plan (task and step), what is wrong, the evidence and the fix.

## Dispatch

This section is the dispatching session's. The session that wrote the plan never reviews inline and never through another agent type.

**Arguments.** `$ARGUMENTS` is `<plan> [phase numbers] [--model <m>]`. Take the plan path and the phase numbers (none means the whole plan). `--model` given more than once or without a value, or any other token, is a stop with one line naming it. When the plan or the part is unclear, ask the owner.

**The model.** `--model <m>` is accepted only when `<m>` is in the reviewer list of `AGENTS.md` ("Roles and models") and matches `^[a-z0-9-]+/[A-Za-z0-9._-]+(#[A-Za-z0-9._-]+)?$`. Otherwise stop with one line naming the value, before creating any directory or dispatching. With no `--model`, the dispatch passes no model and the agent file's model applies. The author model is this session's own model as `provider/model`, or `unknown`.

**The review.**
- The review id is the plan's basename without `.md`, then `-`, then the phase numbers joined by `+`, or `all`: Phases 3 and 4 of `2026-10-28-workflow.md` are `2026-10-28-workflow-3+4`.
- The directory is `.superpowers/review-plan/<review id>/` (git-ignored). The report is `round-<n>.md` there and the owner's rulings are `rulings.md` there. Only you write `rulings.md`; `plan-reviewer` writes only its `round-<n>.md`.
- The round is the next number not yet present. List the directory with the `glob` tool, `path` set to the directory (a pattern from the project root cannot see git-ignored paths), or read the exact path. No directory yet means round 1.

**The brief.** Send these fields, with paths as `plan-reviewer` can resolve them (in full, from `git rev-parse --show-toplevel`):

- **Plan:** the plan path, and the whole plan or the `## Phase N` sections.
- **Round:** `<n>`.
- **Report:** `<top>/.superpowers/review-plan/<review id>/round-<n>.md`.
- **Reviewer model:** the model, then `default` or `owner override`. For `default`, the `model` of `.opencode/agents/plan-reviewer.md`. Each round's brief names the model that round's dispatch uses.
- **Author model:** as above.
- **Previous report:** the path of round `<n-1>` (round 2 and later).
- **What changed:** one line per previous finding, `<id>: <what the author changed>`: fixed, deferred with the reason the plan states, or ruled on by the owner (round 2 and later).
- **Rulings:** the path of `rulings.md`, when it exists.

**Dispatching.** Use the `subagent` tool: agent `plan-reviewer`, in the background, the brief as the prompt, `model` only on an owner override. Leave the plan unchanged until it finishes. If `plan-reviewer` is not available, or the dispatch is refused (quota included), stop and tell the owner: a fresh session for a missing agent, the quota for a refusal. Never fall back to `general` or review inline.

**Its answer.** The final message is the verdict line, then the report path. Read the report there.
- `No review: …`: the brief lacked a field or the report path is unusable. Fix the brief and dispatch the same round again. If the reason is that a file already exists at the report path, the round is finished: read that report and do not dispatch again.
- A second line `report not written: …`: the round left no record, so its verdict counts for nothing. Have the owner resolve the refusal, then dispatch the same round again.
- Any other answer (BLOCKED included): the round gave no verdict. Stop and tell the owner.

## Rounds

- **Not approved:** revise the plan for every Must Fix; fix each Should Fix or defer it in the plan with a stated reason; a Consider is optional. Then dispatch the next round with a fresh brief.
- **At most 3 rounds.** After round 3, or any later round, with Must Fix findings open, the open findings go to the owner, who decides: another round, or how they are settled. Append the decision to `rulings.md` as `- After round <n> (owner's decision): <decision> (<YYYY-MM-DD>)`. It binds later rounds.
- **Approved:** the part may be built. Its Should Fix items are still fixed or deferred in the plan with a stated reason.

## Disputes

A finding the author believes is wrong is neither fixed nor silently ignored. It goes to the owner with both readings, the author's recommendation first. Append the owner's ruling to `rulings.md` (create it if absent) as `- <finding id>: <ruling> (<YYYY-MM-DD>)`. It binds later rounds, whose briefs name the file. Only the owner rules on a dispute.
