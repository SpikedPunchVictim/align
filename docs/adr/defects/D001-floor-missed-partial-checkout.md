# D001 — the floor missed the partial checkout it was written for

**Date** 2026-08-17 · **Severity** S0 · **Shape** [S-01] whole-run guard against per-entry damage ·
**Confidence** measured

The exemplar entry: most defects need only their row in `LEDGER.md`. This one earns a page because
the *fix* was wrong twice before it was right, and a future reader would otherwise reconstruct that
from commit archaeology.

## What shipped

ADR 028 Stage 4 added a "floor": refuse the whole run when the scan is degenerate. It went through
two predicates before review.

**First predicate** — `run.observedFiles.source.size === 0`. Dead on arrival (D003): `align.config.ts`
is a root-level `.ts` file and becomes a graph node, so the observed set is never empty. Measured on
an everything-excluded fixture: `observed.source: ['align.config.ts']`. Caught while writing the doc
comment, by measuring the claim instead of asserting it.

**Second predicate** — every declared component ungrounded. Shipped. Reviewed. Wrong.

## The reproduction

```
components: a: 'a/**', b: 'b/**'      (both empty: 'until-populated')
baseline:   b/one.ts                   (a real cycle violation)

$ rm -rf b && align baseline prune
Pruned 1 fixed violation(s) from the baseline; 0 entries transferred (file moves).
EXIT=0    baseline.json -> []
```

Two independent reviewers found this, by different routes — one via a multi-component partial
checkout, one via a catch-all `**` selector where `align.config.ts` alone keeps the single component
grounded. Reproduced by hand against the built binary before either was acted on.

## Why every guard passed it

This is the part worth keeping. Four independent protections, all correct, all silent:

| Guard | Why it did not fire |
|---|---|
| ADR 023 tier 1 | No gate errored — the scan was fine, the tree was not |
| ADR 023 tier 2 | `complete: true`; dependencies resolved |
| Mechanism 1 (blind-spot record) | A directory that is not there produces nothing to record |
| Mechanism 2 (existence probe) | Correctly answered "absent" — the file genuinely was |
| The floor | One component was still grounded |

Absence from disk had become evidence of deletion, which is the single inference ADR 028 exists to
refuse. The severity zero was not any one guard being wrong; it was that all of them answer per-file
or per-run, and the damage is per-directory.

## Why the obvious fix was not taken

One reviewer proposed per-component grounding: forfeit an entry only if its component observed a
file. That fixes the multi-component route and **misses the catch-all route entirely** — with
`app: '**'`, the component stays grounded by `align.config.ts` and nothing changes. Adopting it would
have closed one reviewer's reproduction while leaving the other's open, which is [S-09] fixed one
arm, missed the other, committed while fixing an instance of [S-01].

## What shipped instead

**Mechanism 3**: an entry whose file is absent from disk AND whose immediate parent directory
produced no observed file at all is retained. A real deletion leaves its siblings behind; a missing
tree takes them all with it. No classification, no workspace index, no type changes — and it covers
both routes because neither depends on component identity.

The floor was deleted outright. It was a per-run guard against per-entry damage, so it both missed
this case and trapped legitimate repositories (D002).

## The cost, and what paid for it

Mechanism 3 cannot distinguish "this checkout lacks the directory" from "I deleted the directory to
pay down the debt". It moves the ambiguity from the file to the directory rather than removing it,
and it lands on the commonest debt-paydown path (D008). The ADR 006 consent gate is what made that
affordable: every deletion asks, so the cost is one keystroke rather than a second command.

**The sound distinguisher exists and was deferred**: git's index separates a sparse-checkout file
(tracked, absent from the worktree) from a deleted one. So would a persisted record of the last
successful scan. Both are ADR-sized decisions about a new dependency. Recorded so the limit is known
rather than rediscovered.

## Pins

- `integration/scenarios/partial-checkout-retains.mjs` — **verified red-before-green in that order**:
  with mechanism 3 disabled and nothing else changed, it fails at three steps. Its header records
  that on nest's `complete: false` scan the direct prune is caught by tier 2 first and the data loss
  surfaces at the delegated `upgrade` step, so the exit-0 form is pinned at fixture level instead.
- `packages/cli/test/prune-retention-and-consent.test.ts` — the exit-0 form, plus the boundary that
  keeps `prune` useful (a file deleted from an *observed* directory is still pruned).

## What this cost to find

Nothing automated found it. It was found by two adversarial reviewers reading code, on a brief
hand-seeded with two unrelated historical shapes. Neither the 1258-test suite nor 17 integration
scenarios nor `align check` registered anything — because the code did exactly what it was written to
do, and what it was written to do was wrong.
