# ADR 022: `.align/version.json` and `align upgrade`

**Status**: Accepted — ships in 0.2.0

## Context

ADR 021 establishes that every persisted artifact should record the align version that wrote it.
This ADR decides where that record lives and what align does with it when the version changes.

The problem is concrete, not hypothetical. The 2026-08-03 audit changed four rule kinds'
fingerprints. A user upgrading across that boundary sees previously-accepted violations reappear
as new debt, with no signal distinguishing "align changed how it fingerprints this" from "someone
introduced a real violation." The current answer is `UPGRADING.md`: a hand-run three-step
ceremony (`prune` → `check` → `accept`) that the user must know exists, find, and execute in
order.

**The scope of the machinery this justifies was an open empirical question, so it was measured
before it was designed.**

Measurement (2026-08-08, HEAD of the audit branch against real pre-audit baselines):

| Repo | Baseline entries | Rule kind | Churned | % |
|---|---|---|---|---|
| n8n | 207 | `arch.no-cycles:repo` (207/207) | **6** | **2.9%** |
| kluster | 8 | `arch.metric:loc:api-app` (8/8) | **0** | **0%** |
| **Total measured** | **215** | | **6** | **2.8%** |

`UPGRADING.md` predicted ~5.5% (≈4% phantom SCC chains + ≈1.4% shortened cycles). Reality is
about half that, same order of magnitude — the prediction was sound, slightly pessimistic.

Two facts from that measurement shape the decision more than the headline number:

1. **Churn is small and hand-reviewable, and align already computes it.** The n8n run reported
   `baselineDebt: {previous: 207, current: 201, delta: -6}` unprompted. The number a user needs
   in order to consent already exists in `CheckRun`; it is not displayed as part of an upgrade
   flow, but it does not need to be derived.

2. **Nobody can tell which version wrote an existing baseline — this was proven by failing to do
   it.** Determining the provenance of `test-apps/n8n/.align/baseline.json` was attempted and is
   impossible: `test-apps/` is gitignored (no history), the file carries no version field, its
   mtime (2026-07-11) *predates the `v0.1.4` tag* (2026-07-28), and sibling baselines disagree in
   shape (`kluster` 8/8 entries carry `contentFingerprint`; `n8n`/`directus`/`fluxify`/`otel-js`
   0/N). The measurement above is therefore *older-than-0.1.4 → HEAD*, not a clean
   `0.1.4 → 0.2.0` migration, and it cannot be made clean retroactively. **The inability to
   establish provenance is the primary evidence for this ADR** — stronger than any argument for
   it, because it is a failure that actually happened.

## Decision

**Write `.align/version.json` — one stamp, recording the align version that last wrote this
`.align/` directory — and ship `align upgrade` as a guided, consent-gated wrapper over the
existing prune/check/accept flow.**

### `.align/version.json`

- **Two fields, and the second records a *reconciliation*, not a *write*.** `alignVersion` — the
  version that last wrote anything in `.align/` — plus `baselineReconciledBy`, the version under
  which the baseline was last deliberately reconciled against a check.

  One directory-wide stamp is insufficient: artifacts are written by different commands at
  different times, and `align build --apply` writes `generated-rules.json`/`rules.lock.json`
  without touching the baseline (`commands/build.ts`). A user who upgrades and then runs
  `build --apply` would advance a single stamp to the new version while the baseline is still the
  old version's work, and `align upgrade` would see no transition and skip the churn it exists to
  surface — a false negative in a mechanism built to catch false results, the same defect ADR 021
  gap 1 fixes in the skew detector.

  **"Last writer of `baseline.json`" does not fix that, and an earlier draft of this ADR specified
  exactly that and was wrong.** The baseline has incidental writers: `align check` persists it on
  any move-transfer (`persistMovedBaseline`, `commands/check.ts:242-248`, called unconditionally
  at `:108`, with a second copy at `mcp/server.ts:45-47`), and `align baseline accept --rule X`
  rewrites the whole file for a scoped accept (`commands/baseline.ts:51`). So: upgrade → CI runs
  `align check` → one renamed file triggers a transfer → the baseline is rewritten by the new
  binary → a "last writer" field reads current → `upgrade` skips the churn. The false negative
  returns through the very field added to prevent it.

  The fact `upgrade` needs is *"has this baseline been reconciled under the running version?"*
  Therefore `baselineReconciledBy` is set **only** by `align init` (which seeds it) and
  `align upgrade` (which reconciles it). No other command touches it — not `check`, not
  `accept`, not `prune`. Incidental writes cannot advance it, which is the entire point.

  A general per-artifact slot mechanism stays in the Design Reserve; two named fields answer
  today's question without inventing a registry.
- **Parsed, not trusted** (ADR 002): a zod schema, permissive to unknown keys, with the
  corrupt-≠-absent discipline the baseline reader gained in the audit
  (`packages/cli/src/align-dir.ts` — a corrupt artifact throws and names its likely cause; it is
  never silently read as empty).
- **Absent is a legitimate state, and is reported by `align doctor` — not `align check`.**
  Every install created before 0.2.0 has no `version.json`. Absence means "unknown, predates
  stamping"; it is never an error.

  **Amended 2026-08-09.** This ADR originally said absence "produces an advisory" on `check`, and
  that was wrong — the implementation followed it literally and the result was immediately visible
  on align's own repo. An absent stamp is not a defect and carries no action. It is the permanent
  steady state for every pre-0.2.0 install *and* for every repo whose users only run `check`,
  which is the CI case and therefore most repos, because a check never creates the file. So the
  advisory fired on every run, could only be silenced by mutating the repo, and would never clear
  on its own. That is how an advisory channel gets tuned out — taking the one genuinely actionable
  signal here, `artifact-version-skew`, down with it.

  `align doctor` is align's read-only advisory survey and already carries every observation of
  this shape (dead tsconfig aliases, empty components, unmapped files, a stale skill snapshot).
  Someone running `doctor` is asking to be told about their setup; someone running `check` is
  asking whether their architecture holds. The observation belongs to the first question.
- **Write discipline — this is the spec, and it is narrower than "unconditionally".** Any command
  that writes an `.align/` artifact also stamps `alignVersion`: `init`, `build --apply`,
  `export-ir`, `baseline accept`/`prune`, `upgrade`, and `check` on the move-transfer path
  (`persistMovedBaseline`). A read-only `align check` — the common case, and the only command CI
  runs — **does not create the file**, because a check must not mutate the repo it is checking.
  A repo whose users only ever run `check` therefore keeps reporting "version unknown"
  indefinitely. That is correct: align genuinely does not know, and inventing a stamp at read time
  would record the *reader*, not the writer, which is the same "last toucher ≠ producer" error
  `baselineReconciledBy` exists to avoid. An errored run stamps nothing, since it writes nothing.

### `align check` reads it

`align check` — not only `align upgrade` — reads `version.json` and emits an advisory when the
running binary **differs from** the stamp. **CI runs `check`, not `upgrade`.** A skew signal that
only appears in a command nobody runs in automation is not a signal. The downgrade direction
(stamp newer than the running binary) is the more dangerous one and is called out explicitly:
artifacts written by a newer align may encode fingerprints this binary cannot reproduce.

**Only the mismatch case reaches `check`.** A missing stamp is silent here and surfaces in
`doctor` instead, per the amendment above. The distinction is actionability: a stamp that
disagrees with the running binary tells a user something about the artifacts they are about to
trust, and is rare. An absent stamp tells them nothing they can act on, and is permanent for most
repos.

### `align upgrade`

A consent-gated flow:

1. Read `version.json`; report the transition (or "unknown → current").
2. Run every **validator** registered for the version range and report what it finds.
3. Run `check` and show the `baselineDebt` delta.
4. Prune orphaned entries, re-accept the churned ones, and apply any **transforms** —
   **only after explicit user consent**, scoped and reviewable.

It inherits ADR 023's two tiers: it refuses outright on an errored scan, and on an incomplete
scan (`complete: false`) it refuses to **delete** without `--allow-incomplete` while still
reporting the transition and the delta. This matters more for `upgrade` than for `prune`, because
upgrade is the command a user runs *once*, at the moment they are least able to tell a
fingerprint change from a real one.

#### Who updates `version.json`, and when

`alignVersion` needs no special handling: it advances through the stamping choke point inside the
artifact writers, so it updates automatically as soon as `upgrade` writes the baseline.

**`baselineReconciledBy` is different and must be set explicitly** — that field exists precisely
because the choke point does *not* advance it (incidental writers would otherwise mark a baseline
"reconciled" that nobody reviewed). `align upgrade` is its second and only other writer besides
`align init`. Three rules govern it:

1. **Stamp last.** Only after consent, and only after the reconciliation has actually completed.
   The ordering is not symmetric and the wrong one looks equally reasonable, so it is written
   down: stamping *before* the work means a run that then fails records a reconciliation that
   never happened, and the next `upgrade` skips real churn. Stamping *after* means a failure
   leaves `alignVersion` advanced but `baselineReconciledBy` stale — and the next `upgrade`
   correctly re-runs. **The safe direction is the one where a crash leaves work looking undone.**
2. **Never stamp without doing the work.** `--notes` is read-only and stamps nothing. A refusal —
   an errored scan, or an incomplete one without `--allow-incomplete` — stamps nothing. Recording
   reconciliation on a run that refused to reconcile would be the false-green shape in a new place.
3. **Partial consent does not count as reconciled.** If `upgrade` surfaces churn and the user
   accepts some entries while deferring others, `baselineReconciledBy` is **not** advanced. The
   field means "the baseline was brought into agreement with this version," and partial means it
   was not. The repeat-prompt concern that moved the unknown-provenance advisory to `doctor` does
   not apply here: `upgrade` is a command a user chooses to run, not one CI runs on every push, so
   a residual reminder is a correct signal rather than ambient noise.

Note the field's current setter is named for `init`'s use (`seedVersionStamp`). With a second
caller it should be renamed to something that covers both — the operation is "record that the
baseline was reconciled under this version", not "seed".

### The migration registry — three tiers, keyed by version

A per-version registry, applied in order across the detected range. Each entry carries up to three
things, and they are separated because their risk profiles are not comparable:

| Tier | Mutates? | Runs | Purpose |
|---|---|---|---|
| **Notes** | no | always | authored prose explaining what changed and why |
| **Validators** | no | always | detect and report state affected by the change |
| **Transforms** | **yes** | only on consent | mechanically fix what a validator found |

**Notes** are authored in `UPGRADING.md` and *compiled* into the registry — never authored twice.
This follows ADR 011 exactly (a markdown doc is the source, the artifact is generated, a content
hash detects drift), and it exists to satisfy ADR 021's one-record invariant: embedding notes in
the binary while also shipping `UPGRADING.md` would be two records of one fact, guaranteed to
diverge. **align never generates migration prose from a diff** — it selects and assembles authored
text for the detected range. A tool inventing descriptions of its own behaviour is a tool
inventing facts.

**Validators are the tier that earns the most and risks the least**, and they cover a failure mode
the baseline flow cannot reach at all. The `**` whole-segment change can make a component selector
match zero files; no command can decide what that selector *should* be, but detecting that it will
reclassify — and naming the files — is exactly what align is for. Validators are read-only, always
run (including under `--notes`), and never require consent.

**Transforms** are consent-gated and constrained:

- **Every transform requires a validator** that detects its precondition. Nothing is mutated that
  has not first been proven to need mutating, and the validator must be runnable standalone so a
  user can see the finding without accepting the fix.
- **Transforms must be idempotent.** Users re-run upgrade; applying twice must equal applying once.
- **A transform that edits `align.config.ts` gets the strictest handling.** That file is authored,
  executable user code, and this repo has already shipped bugs where marker-block handling
  destroyed config content (audit 2026-08-03, BUG #10/#11/#12 — an orphaned start marker caused the
  next run to delete everything up to the block, which for `align.config.ts` meant the ruleset).
  Config transforms must reuse `init/marker-block.ts`'s well-formedness discipline, refuse rather
  than guess, and never silently rewrite a region they did not author.
- Transforms inherit ADR 023's refusal tiers.

**A released version with no registry entry is a build failure, not an empty section.** A missing
entry would otherwise render as "nothing to know about this version," which is the false-green
shape — silence read as an all-clear.

#### All three tiers ship in 0.2.0

Staging validators ahead of transforms was considered and rejected. The case for staging was that
the apply pipeline would ship without ever having run a real migration; the decision is to build
it now and accept that its first genuine exercise may be a later release.

**What each tier must satisfy to be admitted**, regardless of when it ships:

1. Every transform is paired with a validator that detects its precondition, and the validator is
   runnable standalone so a finding can be seen without accepting a fix.
2. Its remediation is **mechanical and unambiguous** — one correct answer, derivable from state
   align can already observe. Anything requiring authorial intent stays validator-only.
3. It is idempotent, and its blast radius is inspectable before it runs.

Criterion 2 is the load-bearing one, and the `**` change shows both sides of it. "Narrow the
selector" and "mark the component `empty: 'until-populated'`" are *intent* decisions a transform
must never make — **a mechanical fix for an ambiguous intent is a wrong fix applied confidently.**
But *"rewrite this selector so its match set is exactly what it was before 0.2.0"* is derivable:
align can evaluate both glob semantics and compute the difference. The user consents to the
intent; the edit itself is unambiguous. That is a legitimate 0.2.0 transform candidate and should
be evaluated first during implementation, precisely because it would give the pipeline a real
first run inside this release.

Some validators will never acquire a transform. That is a correct end state, not an unfinished one.

#### Compensating controls — the pipeline ships less exercised than the rest

Stated plainly rather than assumed away: **the transform apply pipeline may reach users without
having performed a real migration.** These controls are what make that acceptable, and they are
requirements, not suggestions:

- **Preview by default.** A transform shows the exact diff it would apply and requires consent
  before writing. `--notes` already implies a read-only path; applying is never the default of any
  invocation.
- **Refuse on a dirty working tree** for any transform touching `align.config.ts`, so `git
  checkout` is always an intact escape hatch. A user who cannot revert has no recovery from a
  wrong edit, and this is the cheapest possible guarantee that they can.
- **Reuse `init/marker-block.ts`'s discipline** — refuse rather than guess, never rewrite a region
  align did not author. BUG #10/#11/#12 are the precedent for what happens otherwise.
- **Drive it end-to-end on a real repo before release.** The `test-apps/` repos carry real configs;
  constructing a genuine scenario there (an interior `**` selector on `kluster` or `n8n`) and
  running validator → preview → apply → verify is not the same as a user migration, but it is a
  real config rather than a fixture, and it is the difference between "unit tested" and "has run."
- Until that end-to-end run happens, the transform tier is described as **unproven live** in
  release notes and status reports — not "shipped and working."

### Flags

- `--notes` — print the assembled notes and validator findings for the detected range and exit.
  Read-only; mutates nothing. This is the multi-version-hop answer: a user on 0.1.4 arriving at
  0.6.0 gets the union of the intervening entries in order, not four documents to reconcile.
  `align` is the only thing that knows the range — a static document cannot filter itself.
- `--from <version>` — override the detected starting version. Covers a missing or distrusted
  `version.json` stamp, and lets a user preview a hop before taking it.
- `--allow-incomplete` — ADR 023 tier 2 override.

**At 0.2.0 every hop is a single hop**, since there is exactly one prior release. Range assembly
and single-entry selection are therefore the same code today; build the shape that generalizes and
let the assembly logic prove itself when a third release exists.

### Design Reserve — designed, deliberately not built

Recorded with the evidence that kept them out, so they are not re-proposed from scratch:

- **A general per-artifact slot mechanism and `at` timestamps.** The two named fields above cover
  the only artifact whose provenance currently drives a decision. Promote to a slot map when a
  second artifact's write-version starts affecting an outcome. (An earlier draft rejected
  artifact-level granularity outright by citing the 2.8% churn figure — that number measures churn
  *magnitude* and says nothing about provenance *granularity*. Recorded here because the misapplied
  number nearly shipped a stamp that could not answer its own question.)
- ~~**A migration-step registry (version-pair → transform).**~~ **PROMOTED 2026-08-08** — see
  "The migration registry" above. The reserve entry read: *"2.8% churn on 215 entries does not
  justify a migration engine."* That reasoning was defective in the same way as the entry above it:
  **2.8% measures baseline churn and says nothing about config-level breakage.** The `**`
  whole-segment change can make a component selector match zero files and fail the whole
  architecture phase — a failure mode the churn measurement never touched, because it is not a
  baseline problem at all. A number was applied to a question it did not bear on, for the second
  time in one ADR.

  Promoted with the tier separation that the original framing lacked: notes and validators are
  read-only and always run, and only transforms mutate. Most of the value the reserve was blocking
  lived in **validation**, which carries none of the risk that justified reserving it.
- **Automatic accept without consent.** Rejected on the same grounds as ADR 006's baseline
  doctrine: accepting debt is a human decision.
- **An MCP `align_upgrade` tool.** **Rejected, not deferred.** ADR 006 — an agent must not grant
  itself amnesty from accepted debt.

  The framing must be precise, because the obvious version of this argument is **false today**:
  such a path already exists. `align_propose_rules` accepts `accept_new_into_baseline`
  (`mcp/server.ts:150-173`), which reaches `store.accept(result.impact.addedNew, 'manual')` +
  `writeBaseline` (`commands/build.ts:269-273`) — one MCP call, and new violations are accepted
  into the baseline by an agent. So the reason to reject `align_upgrade` is not "no such path
  exists"; it is that upgrade's blast radius is the *whole* baseline rather than one rule
  proposal's additions, and widening an existing narrow hole is not justified by the hole.

  **Settled separately in ADR 024**, which found that the safeguard ADR 006 specifies
  (`allowBaselineFromMcp`, default false) was never implemented — it exists only in prose,
  including in the skill align installs into agents' instructions — and decides to implement it as
  a capability-wide gate. This ADR does not ratify `accept_new_into_baseline`; ADR 024 governs it.

## Alternatives considered

**Keep `UPGRADING.md` as the only mechanism.** Rejected: it requires the user to know the document
exists at the moment they upgrade. The measured churn is small but it is not zero, and the failure
mode when it is missed — reappearing debt indistinguishable from new debt — is precisely the
confusion align exists to eliminate.

**Stamp the version into the artifacts themselves instead of adding a file.** Rejected, and this
is the decision that gives `version.json` its reason to exist. **No `.align/` artifact is
guaranteed to be present**: `generated-rules.json` and `rules.lock.json` require opting into
doc-driven rules (`align build --apply`, ADR 011); `ruleset-ir.json` requires explicitly running
`align export-ir` (`buildExportedRuleset` has one caller, `commands/export-ir.ts:36`, and nothing
invokes it automatically); `baseline.json` does not exist until something is accepted. Provenance
stored inside an artifact is provenance a repo may simply never have. A second, narrower reason
reinforces it: `baseline.json` — the artifact that actually churns — is `z.array(...)`, a bare
array with no envelope to stamp, and giving it one would break reads by any older align a user
downgrades to.

`version.json` is the only record align can write unconditionally, so it is the only viable single
source of truth. ADR 021 accordingly leaves all four artifact schemas unchanged and delegates
provenance here.

**Make a version mismatch a hard error.** Rejected: consistent with ADR 021, skew is an advisory.
A user pinned to an older align deliberately is not in an error state.

**Build the full vetted design as specified.** Rejected on the measurement. The design review
produced a larger mechanism than 6 churned entries out of 207 can justify; the cuts above are the
promotion-on-evidence doctrine applied to our own design.

## Consequences

- Every `.align/` directory gains one small file. Installs upgrading from ≤0.1.4 start with no
  stamp and pick one up on first write.
- `align check` gains an advisory kind. Advisory volume increases for anyone running a binary that
  disagrees with their artifacts — which is the intent.
- `align upgrade` is a thin command. If a future change genuinely cannot be expressed as
  prune-and-re-accept, the reserve above is where the design already is.
- **`UPGRADING.md` changes role rather than going away.** Its three-step ceremony is superseded by
  `align upgrade` and should be dropped. What remains — why fingerprints changed, config-level
  breakage needing human judgment, and no-action-required behaviour changes — becomes the
  **authored source** the notes registry compiles from, so the document is maintained once and
  surfaced by the tool rather than found by the user.
- Its section structure becomes load-bearing: sections must be version-keyed so the compiler can
  select a range. This is a constraint on an existing document, and a release whose section is
  missing or misnamed fails the build.
- `align upgrade` is no longer a thin command. That is a deliberate reversal of this ADR's
  original scope cut, recorded in the Design Reserve above with the reasoning error that caused it.
- **The repo has no CHANGELOG.** `UPGRADING.md`'s "changes that need nothing from you" section is
  release notes wearing a migration guide's clothes, and it is there because there is nowhere else
  to put it. Left as-is deliberately — a CHANGELOG with no release automation behind it rots — but
  named here so the double duty is a choice rather than an oversight.

## Evidence

- **Churn measurement, 2026-08-08**: n8n 6/207 (2.9%), kluster 0/8 (0%), combined 6/215 (2.8%).
  Run with the audit-branch build against unmodified pre-audit baselines; the n8n baseline was
  backed up and verified byte-identical afterward (`align check` did not mutate it).
- **Limits of that measurement, stated plainly**: `directus`, `fluxify`, and `otel-js` were **not
  measured** — they have no `node_modules`, which is also the cause of the three errors an earlier
  attempt recorded (environmental, not migration failure). n = 2 repos, and the two exercise
  different rule kinds.
- **The 2.9% figure is an upper bound, not a clean attribution.** n8n's run reported
  `complete: false` with a `missing-dependencies` advisory (plus three `uncertainty` advisories).
  Missing dependencies drop edges from the graph; a cycle routed through a dropped edge becomes
  unobservable, and its baseline entry then looks orphaned for a reason that has nothing to do
  with the BFS rewrite. Nothing establishes that n8n's dependency state today matches its state
  when the baseline was written in July — and per the provenance failure above, nothing can. So
  **some unknown share of the 6 may be completeness artifacts rather than fingerprint churn.**
  The number is still the right order for scoping `align upgrade` (it bounds churn from above),
  but it must not be cited as "the BFS rewrite moved 6 entries." Attributing it cleanly would
  require reproducing July's `node_modules`, which is not possible.
- **kluster's 0% is structural, not reassuring**: all 8 entries are `arch.metric:loc`, which only
  moves for files sitting at exactly the threshold. An earlier reading of this result as evidence
  that churn is generally near-zero was wrong — it was drawn from the one repo that does not
  exercise the rule that churns.
- **Provenance failure**: documented above; the attempt to date `test-apps/n8n/.align/baseline.json`
  by git history, embedded version, mtime, and schema shape all failed to identify a writing
  version.
- Related: ADR 021 (version provenance invariant), ADR 023 (incomplete-scan refusal), ADR 006
  (baseline consent doctrine), ADR 002 (parse-don't-validate).
