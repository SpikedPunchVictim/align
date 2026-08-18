# The defect ledger

A record of every defect this project has found, **written to sharpen the next review** rather than
to archive the last one. If it ever becomes a filing cabinet, it has failed and should be deleted.

## Why this exists

Sorting align's known defects by what actually found them produces an uncomfortable pattern:

| Discovery instrument | Found |
|---|---|
| A human reading code | BUG #10, BUG #18 — CLAUDE.md states it plainly: *"Every one was found by a human reading code, never by a failing test."* |
| Adversarial review (human or agent) | ADR 027's F1 forged transfer; ADR 028 Stage 4's partial-checkout severity zero |
| The act of *writing* a test | Stage 1's broken volume bound; the root blind spot that protected nothing |
| Measuring a claim while documenting it | Stage 4's dead `observedFiles.size === 0` predicate |
| An executable invariant on the real repo | The reorganization that moved real TypeScript into the scan |
| Integration scenarios | Composition surprises, both surfaced *while the pin was being written* |

**Tests pin; reading discovers.** Expecting the integration harness to find a severity zero is asking
a seatbelt to prevent the crash. The harness is excellent at stopping a fixed defect from returning
and poor at finding an unknown one, and that is not a flaw in the harness — it is what a regression
test is.

So the leverage is not "write more tests after the fact". It is: make the *discovering* instrument
better each time it is used. That is what this directory is for.

## The files

| File | Role |
|---|---|
| `LEDGER.md` | One row per defect. The index that did not exist before — 14 `BUG #` and 2 `FRAGILE #` markers were referenced across 70 files with no way to find them. |
| `SHAPES.md` | The derived catalogue of recurring failure *shapes*. **The source of every review brief.** |
| `<ID>-<slug>.md` | A detail page, only where one earns it — a defect whose reasoning a future reader would otherwise have to reconstruct. |

## The one field that does the work

Not "what broke". **"Which existing check should have caught this, and did not."**

A ledger of what went wrong is a diary. A ledger of which guard failed to fire is a to-do list for
the guards. When one check accumulates misses, that is the signal to strengthen it — and it is a
measured signal rather than a hunch.

## Shape, not instance

The reusable unit is the **shape**. ADR 028 Stage 4's severity zero was not "the floor missed partial
checkouts"; it was *a whole-run guard placed against per-entry damage*. Written that way it is
visibly a sibling of ADR 027's F1 (*fixed one arm, missed the other*) and of ADR 028's own premise
(*absence treated as evidence*). Three instances, one family.

A review brief that names the family hunts it everywhere. A brief that names instances hunts nothing.
This is not theory: the ADR 028 Stage 4 review brief was hand-seeded with two real shapes from this
repository, and both independent reviewers returned real findings, one of them straight from a seed.
`SHAPES.md` makes that systematic instead of ad hoc, and cumulative instead of per-session.

## The escalation ladder

```
defect found -> recorded with its shape -> shape enters the review brief
   -> shape recurs -> promoted to an executable invariant -> the build refuses it
```

The last rung is where a shape stops needing human vigilance. This repository has climbed it three
times already, each on a judgement call made without data:

- `core` imports `node:fs` nowhere — now an executable test
- ADR 026's declared write-sets — now universal and non-opt-in
- `never`-arm exhaustiveness on discriminated unions — now a compile error

The ledger's job is to say **which shape has earned the next rung**, so that decision stops being a
guess.

## Honest limits

- A ledger nobody updates is worse than none, because it will be read as complete. If entries stop
  appearing while defects keep being found, delete the directory rather than let it lie by omission.
- This does not replace the issue tracker. Nothing here tracks work; it tracks *how we were wrong*.
- Backfilled entries are reconstructed from doc comments and ADRs, not measured at the time. They are
  marked as such in `LEDGER.md`, and their details are weaker than entries written fresh.

## Its own success criteria

Judge at 0.3.0, per the probe in `docs/adr/proposals/developer-harness/PROPOSAL.md`:

1. Reviews briefed from `SHAPES.md` find defects that generically-briefed reviews did not.
2. At least one shape recurs and earns promotion to an executable invariant.
3. Entries are still being written without prompting.
