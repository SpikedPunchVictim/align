# Proposal: the developer harness

**Status**: Proposal — not decided, not scheduled. Written 2026-08-17 to capture the idea while the
evidence for it was fresh. Becomes an ADR only if the probe named in §6 produces a result.

**Owner question**: should align ship the working methodology it currently only dogfoods?

---

## 1. The observation

align develops itself under a discipline that is not in the product. This repository has, and the
product ships none of:

- numbered ADRs with a convention, and staged implementation plans carrying testable success criteria
- a defect marker system — **14 `BUG #` markers and 2 `FRAGILE #` markers, referenced across 70
  files, with no index** (measured 2026-08-17). The history is rich and write-only: a defect's story
  is findable only by someone who already knows which file to open.
- declared write-sets (ADR 026) as a universal, non-opt-in invariant
- adversarial review briefs seeded with the repo's own past failure shapes
- `CLAUDE.md` as executable instruction to coding agents

The gap is not that these are undocumented. It is that **the discipline that makes this codebase safe
is local custom, while the product ships a verdict.** A developer adopting align gets `align check`.
They do not get the thing that actually prevented BUG #10 and BUG #18 from recurring.

This is also not a new capability category. `align init` already writes `align.config.ts` and a
`CLAUDE.md` block; `align skill --topic authoring` already ships guidance; the MCP server already
puts align inside an agent's loop. align is *already* in the business of telling agents how to work
in a repository. The harness is that surface, grown up.

## 2. The thesis, sharpened

The obvious version of this idea — scaffold `adr/`, `defects/`, a plan template — delivers the weak
half, and it is worth being precise about why.

Ask what actually prevented defects in this repository:

| Prevented something | Kind |
|---|---|
| `align check` going red | executable |
| ADR 026's write-set invariant | executable, universal |
| `never`-arm exhaustiveness on `ScanBlindSpotReason` | executable |
| "core imports `node:fs` nowhere" | executable |
| ADRs, plans, doc comments | **inputs to judgement — prevented nothing on their own** |

The last row is not a slight; those documents are how the judgement got made. But they do not hold on
their own, and this project has the receipts: ADR 028 Stage 4 shipped a guard whose own doc comment
claimed it covered a case it demonstrably did not (2026-08-17 review, both reviewers). CLAUDE.md
rule 5 — "never treat a doc comment asserting a safety property as evidence" — exists because prose
does not enforce.

**So: scaffold the enforcement, and use the documents as its index.** A harness that produces
directories is a filing cabinet, and filing cabinets already exist (adr-tools, log4brains, GitHub
Issues). A harness that produces *guards* is something else.

## 3. What only align can do

Two capabilities that require a conformance oracle, which is exactly what align already is.

### 3.1 Decision coverage — decisions that are enforced, and decisions that are only prose

An ADR declares the rule that enforces it:

```markdown
**Enforced-by**: arch.no-dependency:core->common
```

`align check` can then distinguish an architectural decision with a guard from one without, and
report the gap: *"ADR 021 records a decision with no rule enforcing it."* That artifact —
**decision coverage** — does not exist in any tool today, and align is a short step from it: ADR 011
already builds rules from markdown, and ADR 018 already enforces doc-reference integrity.

The honest caveat, to be resolved before this becomes an ADR: not every decision is expressible as a
rule. "Prefer composition over inheritance" is not enforceable by a dependency oracle. The metric is
only meaningful if the *enforceable* subset can be identified without turning the number into a
vanity score (see §5).

### 3.2 A ledger that sharpens the next review

A defect ledger whose purpose is not archival but **feeding the next review brief**. The load-bearing
field is not "what broke" — it is *which existing check should have caught this and did not*.

The reusable unit is the **shape**, not the instance. The 2026-08-17 severity zero was not "the floor
missed partial checkouts"; it was *a whole-run guard placed against per-entry damage*. That is a
sibling of ADR 027's F1 (*fixed one arm, missed the other*) and of ADR 028's own premise (*absence
treated as evidence*). Three instances, one family. A brief naming the family hunts it everywhere; a
brief naming instances hunts nothing.

**Direct evidence this works, from this repo, 2026-08-17**: the Stage 4 review brief was hand-seeded
with two real historical shapes ("tests that pass for the wrong reason", "comments asserting
unimplemented guarantees"). Two independent reviewers were run against it. Both returned real
findings, including one straight from a seed. That seeding was ad-hoc; `align review --brief` would
generate it, and it compounds — every recorded defect makes every later review sharper.

### 3.3 The escalation ladder

The two above join into a pipeline the documents alone cannot produce:

```
defect found -> recorded with its shape -> shape appears in the review brief
   -> shape recurs -> graduates to an executable invariant -> build refuses it
```

This repository has already walked that ladder three times by hand — the fs-free test, ADR 026's
universal write-set, and the exhaustiveness arms. Each was a judgement call made without data. The
ledger's job is to say *which shape has earned the next rung*.

## 4. Possible v1 surface

Sketch only, to make the idea testable — not a committed design.

| Command | Does |
|---|---|
| `align init --with-decisions` | scaffolds the ADR tree, the ledger, and the CLAUDE.md section |
| `align adr new <name>` | numbered, dated ADR + its `proposals/<feature>/` directory |
| `align defect new` | ledger entry with the required fields, refusing an entry that omits the "which check should have caught this" field |
| `align review --brief` | prints the review brief derived from the recorded shapes — **the cheapest high-value piece** |
| `align check` | additionally reports decision coverage (§3.1) |

## 5. Open questions

1. **Enforceable vs advisory.** Which decisions can carry a rule at all, and does a coverage metric
   over a subset mislead more than it informs?
2. **How much should align own in someone else's repository?** CLAUDE.md rule 3 already constrains
   align to a marker region in shared files. A harness multiplies the files align writes — see §7.
3. **Is the ledger a chore?** A ledger nobody updates is worse than none: it will be read as complete.
4. **Does it duplicate the issue tracker?** The differentiator must be the shape catalogue and the
   generated brief, not the record-keeping.
5. **Adoption weight.** align's current ask is one config file and a check. This is a much heavier
   ask, and heavier asks lose. Each piece must be independently adoptable and independently valuable,
   with `align check` remaining the anchor that already earns its keep.

## 6. The probe that decides this

Do not build the harness to find out whether the harness is worth building. This repository's own
doctrine is to probe first — that is what `docs/evidence/` is for.

**The probe is the ledger itself.** Build it for this repository, seeded with the defects of ADR 028
Stage 4 while they are fresh and fully measured, and use it through one release cycle.

Success criteria, to be judged at 0.3.0:

- reviews briefed from `SHAPES.md` find defects that generically-briefed reviews did not
- at least one shape recurs and earns promotion to an executable invariant
- the ledger is still being maintained without prompting

If it becomes a chore nobody updates, that is a real answer for the price of a markdown file.

## 7. Risk, stated up front

Every capability here means align writing more files into repositories it does not own. That is the
exact surface that produced BUG #10 (a user's ruleset deleted from `align.config.ts`) and BUG #18
(accepted baselines deleted twice). A harness multiplies it.

**ADR 026's declared write-sets must be a precondition of this design, not a follow-up**, and every
new writer must arrive with its integration scenario (ADR 025) and its write-set already declared.
The severity-zero doctrine does not relax because the feature is about process.
