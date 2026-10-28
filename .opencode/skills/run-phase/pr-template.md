# PR description template

Two variants. `/run-phase` fills the sections it can and leaves *Code-review verdict* empty; `/review-phase` completes it. Delete a variant's guidance lines when filling it.

## Variant A: a plan phase

```markdown
## Summary

<What the phase delivers, in a few lines. A diff sketch or file tree of what changed.>

## Evidence

<Before and after behaviour. The names of the tests that show it.>

## Merge Danger

<The door this change opens (what can now reach what) and its blast radius if wrong.>

## Review-plan verdict

<Latest report covering the phase: path, round, verdict line.>

## Task coverage

| Task | Where it lands | Tests |
|---|---|---|

## Red evidence

<Per new behaviour: the test watched fail and its failing line. Prose-only tasks name the exemption.>

## Deviations

<Every change outside the phase's text, or "none".>

## Executor-level decisions

<Each decision with why, and what in a later phase would force revisiting it, or "none".>

## Rulings

<"Rulings I made" and the owner's rulings, in the order made, or "none".>

## Verification

<The checks each task ran and their results: tsc, smoke, build. Live verification of outside facts, the verified host version, and the unverified surfaces.>

## Code-review verdict

<Left empty by /run-phase. /review-phase fills it: verdict, reviewed head sha, rounds, reviewer model, report name.>

## Deferred findings

<Every "Task <N>: minor (deferred)" line, or "none".>
```

## Variant B: a branch with no plan phase

Drops *Review-plan verdict*, *Task coverage* and *Executor-level decisions*.

```markdown
## Summary

<What the branch delivers, in a few lines. A diff sketch or file tree of what changed.>

## Evidence

<Before and after behaviour. The names of the tests that show it.>

## Merge Danger

<The door this change opens (what can now reach what) and its blast radius if wrong.>

## Red evidence

<Per new behaviour: the test watched fail and its failing line. Prose-only changes name the exemption.>

## Deviations

<Every change outside the stated purpose, or "none".>

## Rulings

<The owner's rulings, or "none".>

## Verification

<The checks run and their results: tsc, smoke, build. Live verification of outside facts, the verified host version, and the unverified surfaces.>

## Code-review verdict

<Filled by /review-phase: verdict, reviewed head sha, rounds, reviewer model, report name.>

## Deferred findings

<Every deferred minor finding, or "none".>
```
