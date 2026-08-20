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

**Instances**: D007, D024(b) — five at once, in text hours old — and the three CLAUDE.md rule 5 cites
("three separate times in four days"). **Rung**: brief.

A doc comment stating what some *other* module does. It is correct when written and rots silently,
and it is trusted precisely because it is specific.

> **Ask**: for every comment claiming another file's behaviour, open that file and confirm. Cited
> line numbers decay fastest.

**D024(b) shows the shape does not need time to rot.** Every one of those five was false *the moment
it was written*, by an author who had just implemented the code it described — a safety guarantee that
greedy-with-consumption matching does not provide, a threat model omitting the one destructive outcome
an attacker can reach, and a writer census of three where a shared helper made it four. So "decay" is
the wrong mental model for the dangerous half of this shape: the dangerous half is a comment written
at the moment of *maximum* confidence, asserting the property the author intended rather than the one
the code has.

> **Ask, sharpened**: for every comment asserting a SAFETY property ("cannot", "never", "only",
> "nothing can"), construct the counter-example before accepting the sentence. If the property is
> worth stating absolutely it is worth a test; if you cannot write that test, weaken the sentence to
> what you can defend. Enumerations ("the set is X, Y and Z") are the same failure wearing a list —
> derive them with a grep, not from memory, and say which grep.

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

**Instances**: ADR 027 F1 (S0), **D010 (S0)**, D016 (S1), D017 (S1), **D020 (S2, twice over)**,
D024(a) (S1), **D025 (S2)**, D028 (S1), **D030 (S0)**, **D034 (S0)**, **D035 (S0)**, D037 (S2),
D038 (S2), D039 (S1), **D041 (S0)**, **D042 (S0)**, D043 (S2), D044 (S2), D045 (S2), D046 (S1),
**D047 (S0)**. **Rung**: brief, **plus three executable invariants** — see below.

**This is the project's dominant shape, and the number is measured, not impressionistic.** Recounted
from `LEDGER.md`'s Shape column on 2026-08-19 after phase 5: **20 of 47 rows**, more than two in
five. Both phase-4 and phase-5 sweeps were near-total — D037/D038/D039, then
D041/D042/D043/D044/D045/D046/D047, seven in a row. No other shape is close. Recount before quoting; this register went stale by six rows
between 2026-08-17 and 2026-08-19, the second time this exact file has been a sample presenting as a
census (see the paragraph below).

**Counting it correctly takes more care than it looks, and the attempt found a second defect.** The
count that matters is the Shape column specifically, and neither `grep -c S-09` nor a naive
`awk -F'|'` gets it right: the first over-counts (rows mentioning S-09 in another column, plus
non-row lines — **24 hits against 20 real instances**), and the second mis-splits any row containing
an escaped `\|` in its prose, silently shifting the column index. The census above splits on
UNESCAPED pipes only and reads field 6, cross-checked against the previous count plus the rows added
since (13 + 7 = 20) — CLAUDE.md §1.4, two independent derivations of one `n`.

Writing that counter is what surfaced the second defect: **two rows carried bare `|` characters
inside shell snippets and prose** (`D026`'s `align skill … | wc -c`, and `D047`'s quotation of the
`|| 'a gate errored'` fallback), so both rendered as 11-column rows in every markdown viewer and were
invisible to any column-indexed count. Both are escaped now, and every row parses to exactly 9 cells
— which is the property a future counter should assert rather than tolerate. A parser that silently
coerces a malformed row is wrong in a way nobody would see.

**D025 is the sharpest instance yet and the cheapest to have avoided**: a guard refusing to write the
scan record from an ERRORED run, shipped hours before review asked what *else* makes a run know less
than the repository contains. The answer — an incomplete run — had had its own name, its own
predicate (`isRunComplete`) and its own ADR (023, "incomplete ≠ errored") for ten days, and the ADR
that shipped the guard cites 023 elsewhere. The arm was not merely missed; the vocabulary for naming
it was already in the author's hands.

> **Ask, for a guard specifically**: a guard exists because some input is untrustworthy. Name the
> PROPERTY that makes it untrustworthy, then enumerate every state with that property. A guard whose
> condition names a *state* (`verdict === 'error'`) rather than the property is one arm by
> construction.

**This register was a sample, not a census, for one day.** It shipped listing three instances while
the ledger tagged four rows `[S-09]` — D010 was omitted, so D017 was recorded as the "third"
instance when it is the fourth, and a claim of "three instances in one day" was really two (D016 and
D017; D010 is older). Found by an adversarial audit that recounted from the ledger's own Shape
column. CLAUDE.md §1.3 names this exact failure — *a register of exceptions that is actually a
sample of exceptions is worse than none, because it will be read as exhaustive* — and it happened
here, in the file that generates review briefs. Recount from `LEDGER.md` before quoting a rate.

A defect class with two call sites. One is fixed; the other has the same shape and is not, because
the fix was framed as a bug rather than a class. CLAUDE.md rule 6 in one line: *hunt the class, not
the instance.*

> **Ask**: grep for every caller of the thing you just fixed. Which of them has the same shape?

**Second executable invariant, 2026-08-19 (D037) — the register pattern.** The first technique below
mechanises one *property*. This one mechanises the *decision*, and it is the more transferable of the
two, because S-09's hard cases are the ones where the two arms should behave DIFFERENTLY and no single
assertion can be right for both. `cli/test/baseline-writers-classify-concurrency.test.ts` enumerates
every module that writes `.align/baseline.json` and requires each to appear in one of two declared
maps — degrade on a concurrent align, or fail loudly — with a written reason. Neither answer is
imposed; what is imposed is that a NEW writer cannot inherit either by saying nothing, which is
precisely how this shape reproduces (ADR 027's note on optional parameters makes the same argument).

The trigger for promoting it: `freshCheck`'s own doc comment had already named this as the function
"that keeps getting missed", listing two prior misses — and it was missed a third time anyway. **A
comment naming a recurring miss is evidence the miss will recur, not a control against it.** When you
find one, that is the promotion signal.

> **Ask, when the two arms should legitimately differ**: can the *choice* be made declarable, so an
> unclassified call site fails a test? A register with reasons beats an assertion that must be wrong
> for somebody.

**Third executable invariant, 2026-08-19 (D046) — the same register pattern, second application, and
that is the finding.** `cli/test/writes-are-atomic.test.ts` enumerates every direct `fs` write under
`packages/cli/src` and requires each to be routed through `writeFileAtomic` or listed in an exemption
register with its reason. It was written by copying the D037 register almost line for line, which is
the evidence the pattern transfers: the two mechanise completely unrelated properties (concurrency
policy; crash atomicity) with the same three assertions — every call site classified, no stale
exemption, every exemption carries a reason. **When a shape has produced two registers, reach for a
register first rather than deriving one.**

**The phase-5 sweep says something the per-row entries do not.** Seven consecutive instances, and in
five of them the unfixed arm was the one that mattered MORE than the fixed arm: D046 protected
align's own regenerable artifacts and left the human's files exposed; D043 zeroed four fields of an
errored run and left the fifth claiming completeness; D044 linted the pattern source align authors
and not the three a human writes by hand; D045's lint was reachable only for the policy its own
comment treats as the afterthought; D047 gave the human surface the full diagnosis and the machine
surfaces none of it. That is not coincidence — the arm that gets built is the arm the
author was thinking about, and the one that matters is often the one they were not.

> **Ask, once you have found the first arm**: which arm did the author have in mind, and which one is
> load-bearing? If those are different, look at the second one first.

**Second instance, 2026-08-18 (D016), and the promotion decision.** `computeBaselineDebt` already
refused to report a debt drop on an errored run, with a comment naming that exact hazard. ADR 028
then introduced a second cause of the identical fabrication — an entry the scan could not observe
also contributes 0 to the sum — and the guard was never extended to it. Note what makes this the
purest form of the shape: the two arms were not two call sites, they were **two causes of one
symptom inside a single function**, so "grep for every caller" would not have found it. The Ask
above is necessary and not sufficient; widen it.

> **Ask (added)**: this guard names one cause of the failure it prevents. Enumerate the other causes
> of the *same observable symptom*. Which of them reaches this code without passing the guard?

**Third instance, 2026-08-18 (D017), a third distinct axis.** D016's two arms were two causes inside
one function; ADR 027 F1's were two call sites. D017's are two *layers*: `loadWorkspacePackages`
reads each member manifest correctly and records what it cannot read, then opens with
`if (patterns.length === 0) return []` — and the function producing those patterns failed silently,
so the careful inner loop never ran at all. A fix is scoped to the code the reproduction touched,
and the reproduction never exercises the layer above.

> **Ask (added)**: what must be true for the code you just fixed to RUN? Whoever decides that is
> inside the blast radius, and a reproduction that starts below it will never implicate it.

**D020, and the reason this shape now leads the register.** D016 fixed one cause of a fabricated
debt delta. Within hours, review found two more causes *of the same symptom, in the same function,
introduced or left by that very fix* — a move-transferred entry counted twice, and duplicate
baseline rows counted as separate debt. The fix enumerated the cause it had reproduced and stopped
at the edge of the reproduction, which is what every instance of this shape has in common.

> **Ask (added)**: you reproduced ONE input that triggers this symptom. Before calling it fixed,
> write down the other inputs that reach the same line — and add a fixture for each, not just for
> the one you happened to hit.

**The general shape cannot be promoted** — "some other arm of this class exists somewhere" is not
decidable, and a check that tried would be a linter for insight. **One sub-case is, and it was used
for D016's own fix**: when a shared computation gains a new input in order to close a hazard, thread
it as a **required** parameter, never an optional one with a default. The compiler then enumerates
every call site and refuses to build until each has been visited — which is exactly the enumeration
the human failed to do. D016's fix made `FileExistenceProbe` a required third argument for this
reason, and the type error it produced named all four consumers (`check` twice, `upgrade`, MCP)
without anyone having to remember they existed. An optional parameter would have silently left MCP
on the old path, which is how this shape reproduces itself.

---

## S-10 — Absence treated as evidence

**Instances**: BUG #1, BUG #18 (both S0), D023 (S0, never implemented), and the whole of ADR 028.
**Rung**: **invariant** (partially) — ADR 023's two tiers and ADR 028's three retention mechanisms
are executable; the underlying inference is not eliminated, only guarded.

The project's most productive shape, and the reason ADR 028 exists. Something is missing — a file, a
violation, a config — and the missing-ness is read as a fact ("deleted", "fixed", "empty") when it
only ever meant "this run did not observe it".

> **Ask**: for every `if (!found)` on a destructive path, what are the reasons `found` could be
> false? Enumerate them all. How many mean what the code assumes?

**D023 is the first instance found in a design document rather than in code, and that is the part
worth carrying forward.** ADR 029 §5 states the antidote to this shape as doctrine — *history is
admissible as a refusal, never as a permission* — and ADR 029 §6, sixteen lines later, licenses a
consumer to do the forbidden thing, because the absence of a violation from the record was read as
"so it did not exist". Both sections were reviewed and accepted; the contradiction surfaced only when
someone tried to write the code. A record of what a run OBSERVED is a fresh supply of absences, so
every consumer of one is a candidate instance of this shape.

> **Ask, for a design document**: the doctrine section and the worked-example section of an ADR are
> written at different moments and are not checked against each other by anything. For each consumer
> the document licenses, name the positive fact that authorizes it. If the answer is "X is not in the
> record", the licence is this shape wearing the document's authority.

---

## S-11 — A writer trusted to stay inside its own region

**Instances**: BUG #10 (S0), D022 (S3). **Rung**: **invariant** — ADR 026's declared write-sets at
the integration level; `connectedClient`'s fixture refusal at the unit level.

A command that writes into a file — or a tree — it shares with someone else, trusted by construction
to touch only its own part.

> **Ask**: what does this command write, and what did it declare? A new writer without a declared
> write-set and an integration scenario is incomplete by definition (CLAUDE.md rules 1 and 2).

**Second instance, 2026-08-18 (D022), one level below where the invariant lives.** ADR 026 covers
integration scenarios; nothing covered unit tests. `mcp.test.ts` started MCP servers against
`test/fixtures/simple-app*` **in place**, which was safe for exactly as long as no MCP tool wrote
anything — and ADR 029 made `align_check` a writer. `pnpm test` then began leaving
`.align/last-scan.json` inside committed fixture directories. Note the shape survives the change of
scale: the "region" was a directory rather than a marker block, and the trust was still structural
rather than checked.

> **Ask (added)**: which tests point a real command at a tree they do not own? A fixture the suite
> shares with git is the same trust relationship as a config file shared with a human.

---

## S-12 — A discipline transplanted from the artifact that earned it

**Instances**: ADR 030 §4 (`.align/.lock`, measured: repository bricked), D021 (ADR 029 §7.4,
`.align/last-scan.json`, caught before it shipped). **Rung**: brief — see the declined promotion
below.

A safety rule is derived, correctly and at cost, for one artifact. It then gets applied to a second
artifact **by name rather than by re-derivation**, and at the second one its failure mode is
inverted, so the rule now causes the class of harm it was written to prevent.

Both instances are the same rule: *corrupt is never read as absent* (BUG #1 — a corrupted
`.align/baseline.json` read as `[]`, then destroyed by the next full-snapshot write). That is right
for `baseline.json`, which holds irreplaceable human consent nobody can regenerate. Applied to a
file **align itself creates, owns and replaces on every run**, the same rule means an unreadable file
the user cannot see in `git status` blocks every command until they delete it by hand — a bricked
repository, to protect data that did not exist.

> **Ask**: this rule was written for a specific artifact. For the artifact you are applying it to
> now: who authored the data, can align regenerate it, and what happens if the rule fires wrongly?
> If the answers differ from the original, re-derive the rule instead of citing it.

**The criterion already existed, which is what makes this shape worth a register entry.** `readBaseline`'s
doc comment states it in one line — *"Mirrors `readRulesetIr`'s discipline, not `readTelemetryState`'s
— this file holds irreplaceable human consent decisions, not a regenerable cache"* — and
`readTelemetryState` four functions below it is the worked example. Both instances of this shape were
written by someone with that text in the repository. A shape whose antidote is already documented and
still recurs is not an information problem; it is a *reflex* problem, which is exactly what a review
brief is for.

**Promotion declined, and the reason recorded.** The obvious executable form — "every reader of a
machine-local `.align/` file returns absent on corruption" — would today be a list of two readers
(`readLastScanRecord`, `readTelemetryState`), both already pinned by their own tests, and the
enumeration itself would be the thing that goes stale. The generalizable half is not the rule but the
*question*, which is what the Ask above encodes. Revisit if a third machine-local artifact appears:
at three, the list stops being a list and starts being a class.

---

## S-13 — A defect that disables the instrument that would find it

**Instances**: D033 (S3, three files at once), **D040 (S3 — in the report about D033)**. **Rung**:
**invariant**, widened on the second instance.

Most defects are found by an instrument. This shape is the one that breaks the instrument first, so its
own detection probability drops to near zero and stays there. D033 is the clean example: three source
files contained a raw NUL byte, which makes `grep` skip the file silently and `git diff` render it as
`Bin … bytes, 0 insertions, 0 deletions`. The code was correct. What broke was the ability to *review*
the code — and specifically the two instruments this project names most often, a human reading a diff
and a grep receipt for a negative claim (CLAUDE.md rule 3).

It surfaced only because an agent's grep returned nothing for a symbol it could see in the file, and it
chased the contradiction instead of recording the absence.

> **Ask**: for any artifact this project reasons about — source files, diffs, logs, reports, the ledger
> itself — what would make it *invisible* to the tool we check it with, rather than merely wrong in it?
> An absence result that surprises you is the signal; treat "grep found nothing" as a claim to verify,
> not an answer.

**Second instance, 2026-08-19 (D040), and it is the sharpest illustration this register will get: the
report documenting D033 contained a raw NUL of its own**, at the exact spot where it wrote "instead of
the escape `\u0000`". The file explaining why sources must not be binary to git and grep was itself
binary to git and grep, from the day it was committed — so its diffs, including a status section added
weeks later, all landed as `Bin … bytes, 0 insertions, 0 deletions`.

The invariant promoted for D033 did not catch it, because it was scoped to `.ts`/`.js` and skipped
`.agents/`. **A guard scoped narrower than the property it protects is one arm by construction** —
which is S-09's ask pointed at a guard rather than a call site, and worth noting as the cheapest
cross-check between these two shapes. The scope is now every `.ts`/`.js`/`.md` file outside build
output and vendored trees, which is where this project's reasoning actually lives: `LEDGER.md` is the
record of how we were wrong and `SHAPES.md` generates the review briefs.

Found by reading `git diff --stat` on an unrelated edit and noticing the `Bin` line — the same way the
first instance surfaced, and the reason the Ask above is phrased around *surprising tool output* rather
than around NUL bytes.

> **Ask, when promoting any invariant**: name the property, then name every artifact that has it. If
> the guard's file-extension list is shorter than that answer, the guard is already one arm.

**Promoted on the first instance, which is a departure worth stating.** This register's rule is to
promote on the second, because the cost of an executable invariant usually is not justified before
then. Two things overrode it here: there were already three occurrences in one finding, and the
invariant is fifteen lines with no runtime cost. The rule is a heuristic about cost versus evidence —
when the cost collapses, so does the threshold.
