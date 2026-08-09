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
- **Absent is a legitimate state.** Every install created before 0.2.0 has no `version.json`.
  Absence means "unknown, predates stamping" and produces an advisory, never an error.
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
running binary differs from the stamp. **CI runs `check`, not `upgrade`.** A skew signal that only
appears in a command nobody runs in automation is not a signal. The downgrade direction
(stamp newer than the running binary) is the more dangerous one and is called out explicitly:
artifacts written by a newer align may encode fingerprints this binary cannot reproduce.

### `align upgrade`

A consent-gated flow over mechanisms that already exist:

1. Read `version.json`; report the transition (or "unknown → current").
2. Run `check` and show the `baselineDebt` delta — the measured 6-of-207 shape.
3. Prune orphaned entries and re-accept the churned ones **only after explicit user consent**,
   scoped and reviewable.

It inherits ADR 023's two tiers: it refuses outright on an errored scan, and on an incomplete
scan (`complete: false`) it refuses to **delete** without `--allow-incomplete` while still
reporting the transition and the delta. This matters more for `upgrade` than for `prune`, because
upgrade is the command a user runs *once*, at the moment they are least able to tell a
fingerprint change from a real one.

### Design Reserve — designed, deliberately not built

Recorded with the evidence that kept them out, so they are not re-proposed from scratch:

- **A general per-artifact slot mechanism and `at` timestamps.** The two named fields above cover
  the only artifact whose provenance currently drives a decision. Promote to a slot map when a
  second artifact's write-version starts affecting an outcome. (An earlier draft rejected
  artifact-level granularity outright by citing the 2.8% churn figure — that number measures churn
  *magnitude* and says nothing about provenance *granularity*. Recorded here because the misapplied
  number nearly shipped a stamp that could not answer its own question.)
- **A migration-step registry (version-pair → transform).** 2.8% churn on 215 entries does not
  justify a migration engine. Promote when a change lands that cannot be expressed as
  prune-and-re-accept.
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
- **`UPGRADING.md`'s three-step ceremony is over-specified relative to the measurement** and
  should be revised to lead with `align upgrade`, keeping the manual steps as the fallback.

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
