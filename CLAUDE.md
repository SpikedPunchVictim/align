<!-- align:start -->
## align — architecture conformance

This repo is checked by [align](https://github.com/SpikedPunchVictim/align) for dependency-direction and import-cycle
conformance. Run `align check` (or the `align_check` MCP tool if the align MCP server is
connected) after any structural code change — new imports, moved files, restructured modules.

**A red `align check` is blocking.** Do not consider a structural change complete while
`align check` reports red. Run `align explain <ruleId>` (or the `align_explain_rule` MCP tool)
to understand why a rule fired before proposing a fix.

For full rule-authoring guidance run `align skill --topic authoring`.
<!-- align:end -->

## Destructive safety — required for every feature that writes

align writes into repositories it does not own, so a defect here damages a developer's working
tree rather than returning a wrong answer. This has happened: `align init` deleted a user's
ruleset from `align.config.ts` (BUG #10), and `prune`/`init` deleted accepted baselines twice
(BUG #18, ADR 023 and its amendment). Every one was found by a human reading code, never by a
failing test.

**These rules are not optional, and they apply to new work by default:**

1. **Declare the write-set.** ADR 026: a command may create, modify, or delete only the paths its
   scenario declares; every other path must be byte-identical afterward. New scenarios default to
   the empty write-set (nothing may change), so a new command or flag fails until its author
   states what it is licensed to touch. Do not widen a write-set to make a test pass without
   understanding why the command is writing there.
2. **A new command or flag is not complete without an integration scenario** (ADR 025). If you
   added a flag and did not add or extend a scenario, the feature is unfinished.
3. **`align.config.ts` and `CLAUDE.md` are shared with the human.** align owns only the region
   between its markers. Any writer touching those files must leave the outside byte-identical —
   that is the exact property BUG #10 violated, and it is asserted, not assumed.
4. **A destructive mutation computed from a `CheckRun` must pass ADR 023's guards** —
   `refuseIfRunErrored` (tier 1, no override) and `refuseIfRunIncomplete` (tier 2,
   `--allow-incomplete`). A new destructive consumer that does not call them is a defect by
   definition. Add-only and transfer-only consumers are exempt, but the exemption must be pinned
   by a test.
5. **Never treat a doc comment asserting a safety property as evidence.** It is a claim to verify.
   Three separate times in four days this repo shipped a comment describing a guarantee nothing
   implemented.
6. **"Reports success wrongly" outranks everything.** A command that destroys data and exits 0 is
   the project's severity-zero class. When you find one, hunt the class, not the instance.

### Verifying a change

```
pnpm build && pnpm typecheck && pnpm test      # ~26s, 1511 tests — the fast gate, run it always
node packages/cli/dist/index.js check          # must be green; red is blocking
node packages/cli/dist/index.js doctor         # advisory only, always exits 0
node integration/run.mjs --targets local       # Docker; real project, real command sequences
node integration/run.mjs --targets local --project nest-incomplete   # the ADR 023 tier-2 scenario
```

**Both project lines are required.** `run.mjs` defaults to `--project nest` and filters by project,
so the first line alone silently skips every scenario declared against another project — today that
is `prune-incomplete-scan-requires-allow-incomplete`, the only coverage ADR 023 tier 2 has at the
integration level. A release-gate scenario the release-gate command does not execute is not
calibration; this was found by review on 2026-08-18 (`docs/adr/defects/LEDGER.md` D012) after the
consent gate broke that scenario and nothing reported it.

The full cross-version matrix (`--targets 0.1.4,local`) is a release gate — **ten** scenarios carry
`expectFailOn: ['0.1.4']` as its calibration (recounted 2026-08-19 after
`accept-does-not-restamp-provenance` was calibrated; it was three when this line was written, and
grows whenever a defect is pinned against a published version), and if those ever pass against 0.1.4
the harness has stopped working and nothing it reports can be trusted. Recount with
`grep -c '^  expectFailOn' integration/scenarios/*.mjs` rather than from memory — the comment blocks
in those files mention `expectFailOn` far more often than the field is actually declared, so a
grep for the bare word overcounts by four.

## 1. Rigour on load-bearing claims

**Applies to** any artifact someone will act on without re-deriving it: findings, reviews,
measurements, corrections, benchmark results, architecture decisions, migration plans. **Does not
apply** to exploratory work, throwaway analysis, or a first pass you are about to throw away — if
which mode you are in is unclear, say so in one line and continue.

The failure this prevents is not sloppiness, which is easy to spot. It is **plausible work**:
internally consistent, confidently written, correct in the places you checked, and wrong in the two
or three you did not. Plausible work is more dangerous than obviously bad work, because it is
adopted.

### 1.1 Derive, don't recall

- A number you assert must be derived **in this session, from the primary artifact**. Copying a
  figure out of your own earlier message is the most common way an error propagates — **your
  earlier self is not a source.**
- If a number originates in prose (a plan, a comment, a summary, a README), recompute it before
  repeating it. If it does not reproduce, that is a finding. Do not round it into agreement.
- Name the estimator whenever one exists. "Median per rung, OLS over nine points" is a claim that
  can be checked; "the exponent" is not.

### 1.2 Read your own tool output

- Search results are evidence, not a lookup. If a grep prints a file that contradicts the claim you
  are about to write, **that line is the most important thing in the output.** Do not summarise
  past it.
- Before writing "X is unused / unread / uncalled / absent", grep for X and read **every** hit,
  including hits in files you did not expect. Most false negatives of this form are visible in
  output the author already generated.

### 1.3 Ask the completeness question

- "Is X true?" and "what else is like X?" are different questions, and only the second produces a
  complete list. Enumerate the space first, then subtract what you have verified.
- A register of exceptions that is actually a *sample* of exceptions is worse than none — it will
  be read as exhaustive.
- After any list, ask explicitly: what would belong here that I never looked for?

### 1.4 Count precisely

Every count must state what it counts. Lines, records, rows, and *valid* rows are four different
numbers. Cross-check any `n` against an independent source — a scored artifact, a test count, a
second query — before quoting it.

### 1.5 Keep confidence classes separate

Label each claim **measured**, **inferred from code/spec**, or **unmeasured**, and never blur them
inside one sentence. A mechanism measured in one context and asserted in another is *inference*,
however strong the mechanism. Report the classes separately even when they point the same way.

### 1.6 Primary vs supporting figures

When a source defines a primary statistic, quote the primary. Read what the source calls its own
headline before adopting a number from it. Pairing one experiment's primary with another's
supporting output is not a comparison, even when both are correct in isolation.

### 1.7 Verify every citation you write

`file:line`, commit SHAs, section numbers, test names, URLs. Cite it, then open it and confirm it
says what you claim. Citations decay, and a confidently wrong one costs a future reader more than
no citation at all. This applies to citations handed to you by a tool, a subagent, or a reviewer —
**verify borrowed citations before adopting them.**

### 1.8 Switch stance before you finish, not after

The highest-leverage item in this section. Authoring and checking are different jobs, and the
author is the worst available checker, because they check the parts they thought about.

Before committing a load-bearing artifact:

1. **Name the three claims that would be most damaging if wrong.** Usually the ones the artifact's
   authority rests on — not the ones that were hardest to produce.
2. **Attack those three as someone who believes they are false.** Recompute; do not re-read.
3. **Write down what you could not check, and why.** An acknowledged gap is worth more than a
   confident guess, and omitting the gap *is* the error.
4. **Distinguish factual errors from judgment disagreements** in whatever you report.

For anything durable, prefer a **separate adversarial pass** — a subagent given a review brief
works well precisely because it cannot see what you meant, only what you wrote. Brief it to
recompute rather than confirm, to test the list for completeness, to verify cited line numbers,
and to report what it could not check. Run it **before** the commit: a review that arrives after
publication is a correction, not a check.

### 1.9 Budget it deliberately

This section is expensive and is meant to be. Spend it on artifacts that will be trusted without
re-derivation, and say plainly when you are choosing not to — "spot-checked, not exhaustively
verified" is an honest and often correct thing to write. Silence about depth reads as a claim of
depth.

## 2. The defect ledger — required for every defect you find or fix

`docs/adr/defects/` is this project's record of **how we were wrong**, kept to sharpen the next
review rather than to archive the last one. Read `docs/adr/defects/README.md` once before using it.

### When you find a defect

Add a row to `docs/adr/defects/LEDGER.md`, newest first. It is not optional and it is not deferred to
"after the fix" — write it while the reproduction is still in front of you, because the fields that
matter are the ones you will not be able to reconstruct later.

Every row needs all nine columns. Three of them are where the value is, and they are the three most
likely to be filled in lazily:

- **Discovery instrument** — what actually found it. Not "testing"; name the thing. *Adversarial
  review*, *a human reading code*, *the act of writing a test*, *`align check` on the real repo*,
  *an existing test when the fix was applied*. This column is how the project learns which
  instruments are worth investing in.
- **Shape** — the reusable abstraction, referencing a `SHAPES.md` id (`[S-01]`). If no existing shape
  fits, add one. "The floor missed partial checkouts" is an instance; *a whole-run guard placed
  against per-entry damage* is a shape. Only the second one transfers.
- **Which check should have caught it, and did not** — the engine of the whole system. Often the
  honest answer is "nothing", and that is a finding, not a blank. When one check accumulates misses,
  that is the measured signal to strengthen it.

Mark **Confidence** `measured` only if you reproduced it yourself in this session with numbers from a
real run. Anything reconstructed from a doc comment or an ADR after the fact is `reconstructed`, and
its incidental detail must not be quoted as fact.

Write a `<ID>-<slug>.md` detail page **only** when a future reader would otherwise reconstruct the
reasoning from commit archaeology — a fix that was wrong before it was right, or a defect several
guards passed. Most defects are a row and nothing more. `D001-floor-missed-partial-checkout.md` is
the exemplar for length and tone.

### When you review code

**Build the review brief from `SHAPES.md`, not from scratch.** Copy the questions of the shapes
relevant to the change under review; do not paste the file wholesale, or the brief stops being about
the change. This is the ledger's whole purpose — a brief naming the family hunts it everywhere, a
brief naming instances hunts nothing.

### When a shape recurs

A shape with a second instance has earned promotion from a brief line to an **executable invariant**,
so nobody has to remember it. Precedents in this repo: "core imports `node:fs` nowhere", ADR 026's
universal write-sets, `never`-arm exhaustiveness. Say so explicitly in the ledger row rather than
leaving the judgement to the next reader — and if you decline to promote it, record why.

### What not to do

- Do not add a row for a defect you introduced and caught within the same edit, before it ran. The
  ledger records what got past you, not every typo.
- Do not let a fix land without its ledger row. A row with no fix yet is fine and useful; a fix with
  no row loses the only evidence of how it was found.
- Do not treat the ledger as complete. It starts at 2026-08-17 with a handful of reconstructed
  historical rows; older defects live only in `BUG #` markers scattered across the codebase.