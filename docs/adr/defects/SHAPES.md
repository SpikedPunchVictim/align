# Failure shapes

The reusable half of `LEDGER.md`. **This file is the source of every review brief** — see `README.md`
for why the shape, not the instance, is the unit that transfers.

Each shape carries the question a reviewer should actually ask. Copy the questions of the shapes
relevant to the change under review into the brief; do not paste this file wholesale, or the brief
stops being about the change.

**Promotion**: when a shape recurs, it has earned an executable invariant. The `Rung` column tracks
how far up the ladder it is — `brief` (a question a human or agent must remember to ask) or
`invariant` (the build refuses it, and nobody has to remember).

---

## S-01 — A whole-run guard placed against per-entry damage

**Instances**: D001 (S0), D002. **Rung**: brief.

A guard that refuses the *entire run* when some global condition holds, protecting damage that is
actually decided per entry. It fails in both directions at once: it misses the case where the global
condition is false but individual entries are still doomed, and it blocks legitimate work when the
condition is true but nothing was at risk.

> **Ask**: at what granularity does this guard fire, and at what granularity does the damage occur?
> If they differ, name the case where one component / entry / file is affected and the others are not.

---

## S-02 — A predicate that is unreachable in practice

**Instances**: D003. **Rung**: brief.

A guard whose condition can never be true in a real repository, so it reads as a guarantee and
delivers nothing. CLAUDE.md rule 5's exact class, arrived at from the code side rather than the
comment side.

> **Ask**: construct an actual repository state where this condition holds. Not a unit fixture — a
> repository. If you cannot, the guard is decoration.

---

## S-03 — A comment asserting a fact about other code, unverified

**Instances**: D007, and the three CLAUDE.md rule 5 cites ("three separate times in four days").
**Rung**: brief.

A doc comment stating what some *other* module does. It is correct when written and rots silently,
and it is trusted precisely because it is specific.

> **Ask**: for every comment claiming another file's behaviour, open that file and confirm. Cited
> line numbers decay fastest.

---

## S-04 — A guard correct in the unsafe direction and wrong in the safe one

**Instances**: D008. **Rung**: brief.

Safety fixes are graded on whether they prevent the damage, and rarely on what they cost. A guard
that retains everything is perfectly safe and perfectly useless, and "safe but useless" gets shipped
because it feels like the conservative choice.

> **Ask**: what does this guard now block that a user legitimately wants? How often, on which
> workflow? If the honest answer is "the commonest one", the fix is not finished.

---

## S-05 — A test that passes for the wrong reason

**Instances**: D006, plus two pre-existing tests that passed because destructuring a string yielded
`undefined`, plus a duplicate `stdoutContains` key written and caught by hand while fixing
`partial-checkout-retains` (2026-08-17). **Rung**: **executable invariant, partially** — see below.

The assertion holds for a reason unrelated to the property named in the test title. Invisible while
green.

> **Ask**: revert the implementation this test names and confirm it fails. If the final assertion
> would be identical under a broken implementation, it is pinning nothing.

**Promoted 2026-08-18, for the one sub-case a machine can decide.** An integration scenario's
`expect` block is a plain JS object literal, so two `stdoutContains` keys are legal and JavaScript
keeps only the last — the first assertion vanishes and the scenario still passes.
`validateNoDuplicateKeys` (`integration/lib/spec-validate.mjs`, called from `run.mjs`'s
`loadScenarios`) now parses each scenario's SOURCE and refuses to run on any duplicate key in any
object literal. It has to read the text: by the time `import()` resolves, the duplicate is already
gone, which is why no check on the loaded object could ever have caught it.

The rest of the shape stays a brief and always will. "This assertion passes for a reason unrelated
to its title" is not decidable; the duplicate-key case was decidable, so it is now decided
automatically and nobody has to remember it.

---

## S-06 — A path-based configuration silently widened or narrowed by a file move

**Instances**: D009. **Rung**: brief. **Candidate for promotion** — see below.

Excludes, selectors, write-sets and glob patterns are coupled to paths. Moving files is treated as
inert refactoring, and the coupling is invisible until something scans the wrong tree.

> **Ask**: does this move cross a boundary named in `align.config.ts`, a write-set, or a scenario?
> Does any moved directory contain *code* rather than prose?

**Promotion note**: this is the strongest current candidate for the next executable invariant. A test
asserting the dogfood scan's expected file-set size (or that no file under `docs/` is scanned) would
have caught D009 in the same second it was introduced. Not yet built — recorded so the decision is
deliberate rather than forgotten.

---

## S-07 — A guard reintroducing the exact defect it was written to prevent

**Instances**: D005. **Rung**: brief.

A function exists to stop a class of wrongness, then grows a new code path that does the wrong thing
again — usually because a new input was added and the guard's own logic was not revisited.

> **Ask**: read the function's stated purpose, then enumerate its inputs. Is every combination
> covered, or only the ones that existed when it was written?

---

## S-08 — A new flag's interaction with an existing guard, unexamined

**Instances**: D004. **Rung**: brief.

Each guard is correct alone. The new flag's path through them was never traced, so the composition is
discovered in production — or, if you are lucky, on a scenario's first run.

> **Ask**: for each existing guard, does the new flag reach it, bypass it, or change the count it is
> fed?

---

## S-09 — Fixed one arm, missed the other

**Instances**: ADR 027 F1 (S0). **Rung**: brief.

A defect class with two call sites. One is fixed; the other has the same shape and is not, because
the fix was framed as a bug rather than a class. CLAUDE.md rule 6 in one line: *hunt the class, not
the instance.*

> **Ask**: grep for every caller of the thing you just fixed. Which of them has the same shape?

---

## S-10 — Absence treated as evidence

**Instances**: BUG #1, BUG #18 (both S0), and the whole of ADR 028. **Rung**: **invariant**
(partially) — ADR 023's two tiers and ADR 028's three retention mechanisms are executable; the
underlying inference is not eliminated, only guarded.

The project's most productive shape, and the reason ADR 028 exists. Something is missing — a file, a
violation, a config — and the missing-ness is read as a fact ("deleted", "fixed", "empty") when it
only ever meant "this run did not observe it".

> **Ask**: for every `if (!found)` on a destructive path, what are the reasons `found` could be
> false? Enumerate them all. How many mean what the code assumes?

---

## S-11 — A writer trusted to stay inside its own region

**Instances**: BUG #10 (S0). **Rung**: **invariant** — ADR 026's declared write-sets, universal and
fail-closed.

A command that writes into a file it shares with a human, trusted by construction to touch only its
own part.

> **Ask**: what does this command write, and what did it declare? A new writer without a declared
> write-set and an integration scenario is incomplete by definition (CLAUDE.md rules 1 and 2).
