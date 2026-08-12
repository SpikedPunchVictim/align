# ADR 023: Incomplete Scans Never Mean "Fixed"

**Status**: Accepted

## Context

An errored gate reports `violations: []` and `baselinedCount: 0`. `orchestrator.ts` builds
`errorGate(err, …)` and returns immediately, before any rule is evaluated — so on an `error`
verdict **every** violation is absent from the run, including every violation that is genuinely
still there.

Absent means "this scan never verified it." It does not mean "fixed." Five places in the codebase
read it as "fixed."

Three were **reporting** sites, already documented and guarded by `computeBaselineDebt`
(`packages/cli/src/commands/check.ts`) — they printed a wrong number. Two were **mutating** sites,
found by the 2026-08-03/08 audit as BUG #18, and they destroyed data:

- **`align baseline prune`** deleted every accepted entry. With all violations absent, every
  baseline entry looked orphaned, and `store.prune` deletes an orphan whose file is still present.
  It then printed `Pruned N fixed violation(s)` and **exited 0**. Reproduced end-to-end by
  shadowing a component so the run errored:

  ```
  baseline BEFORE: 1 entries
  check verdict:   error
  Pruned 1 fixed violation(s) from the baseline...
  prune exit:      0
  baseline AFTER:  0 entries
  ```

- **`align init`** wrote `[]` over an existing baseline and printed `Initial check is green`.

Both are the worst available failure shape: **silent data loss reported as success, exit 0.** A
user with accepted debt loses their consent record, CI stays green, and nothing indicates it
happened.

Neither could be caught downstream. `orchestrator.knownFiles` only re-scans — it never runs
`validateSelectorSyntax`, `validateClassifiedComponents`, `validateRuleComponentRefs`,
`validateHostRules`, or rule evaluation, which are the error sources in `check()`. A run that
errors in `check()` still yields a perfectly healthy `knownFiles`, so the second signal a caller
might have leaned on agrees with the first and is equally wrong.

That this class reached five copies — and that each was found separately rather than by the
guard's existence — is the reason it warrants an ADR rather than a patch.

### The second axis: incomplete ≠ errored

A run can also fail to see everything *without* erroring. `complete` is computed independently of
the verdict — `complete = !run.advisories.some((a) => a.kind === 'missing-dependencies')`
(`packages/core/src/payload/builder.ts:82`) — so a run can be `verdict: 'red', complete: false`,
which `refuseIfRunErrored` passes straight through.

That combination is not exotic; it is the normal state of a large repo with an incomplete install.
`align check` on `test-apps/n8n` returns exactly it, with 6 baseline entries appearing orphaned.
Missing dependencies drop edges from the graph, and a cycle routed through a dropped edge becomes
**unobservable, not fixed** — its baseline entry then looks orphaned for a reason that has nothing
to do with the code. `align baseline prune` would delete those entries and report success.

This is the same defect as the errored case, reached by a different route, and an earlier draft of
this ADR missed it entirely: it was titled for incompleteness while gating only on errors.

## Decision

**Invariant: a command that destructively mutates persisted state from a `CheckRun`'s violations
must refuse when the scan did not see everything — whether it errored or merely could not resolve
the whole graph.**

Two tiers, because the two ways a scan falls short differ in how recoverable they are:

**Tier 1 — errored run: refuse absolutely, no override.** Enforced by `refuseIfRunErrored`
(`packages/cli/src/errored-run.ts`), called **before** any store is constructed and before any
file is written. `deriveVerdict` guarantees that any errored gate implies `verdict: 'error'`, so
the verdict alone is the complete test — a mutating site does not need to inspect individual
gates. There is no flag to proceed: an errored scan evaluated *no rules at all*, so there is
nothing a user could knowingly consent to.

The guard prints the errored gate's own message rather than a generic one. Those messages are
already actionable (they name the shadowed component and the `empty:` opt-out, for example);
replacing them with "scan failed" would discard the diagnosis.

**Tier 2 — incomplete run (`complete: false`): refuse to DELETE, overridable by an explicit
flag.** A scan that resolved only part of the dependency graph did evaluate real rules, so its
results are partially meaningful — but an absent violation is still unverified, and deletion is
irreversible. Deletion therefore refuses by default, names the count at risk and the reason, and
proceeds only under `--allow-incomplete`:

```
align baseline prune: refusing to delete 6 entries — this scan could not resolve all
  dependencies (missing-dependencies advisory), so an absent violation may be unobservable
  rather than fixed. Re-run with dependencies installed, or pass --allow-incomplete.
```

The override exists because some repos cannot practically reach a complete install, and a rule
with no escape hatch would simply be worked around. The default is refusal, so the unsafe path
requires a deliberate act that shows up in a shell history or CI config.

**Tier 2 gates deletion only.** Transfers and adds proceed normally on an incomplete scan — they
cannot destroy a consent decision, which is the thing being protected.

**The invariant covers DESTRUCTIVE mutation — deletion or full overwrite — not every write.**
Two classes of baseline write are exempt, and both exemptions are verified rather than assumed:

- **Add-only.** `align baseline accept` builds its store from the on-disk entries and only ever
  calls `store.accept` (`commands/baseline.ts:47-51`), so an empty violation set makes it a no-op
  rewrite of the same entries. Pinned by
  `packages/cli/test/errored-run-mutations.test.ts:178-188`.
- **Transfer-only.** `persistMovedBaseline` (`commands/check.ts:242-248`, called unconditionally
  at `:108`, with a second copy at `mcp/server.ts:45-47`) writes the baseline when a
  `baseline-moved` advisory is present. This **can** fire on an errored run — the security gate
  runs before the architecture gate, so its move count reaches `movedAdvisories` on the arch-error
  return paths — and it deliberately does **not** call `refuseIfRunErrored`. It is safe because
  `reconcileMoves` transfers and never deletes (`baseline/store.ts:42-59`), and same-`ruleId`
  matching prevents cross-domain mis-transfer. Naming it here matters: without this clause, the
  rule below would classify align's own shipped code as defective.

Applied at both destructive sites: `baselinePrune` (`commands/baseline.ts:93`) and `runInit`
(`commands/init.ts:138`, before both write paths at `:155` and `:183`).

## Alternatives considered

**Have the orchestrator throw instead of returning an error gate.** Rejected: the error gate is
load-bearing for reporting surfaces — `align check` and the MCP payload both need to *render* a
failed run with its diagnosis, not catch an exception. The gate model (ADR 008) is right; the
consumers were wrong.

**Make `store.prune` itself refuse on an empty violation set.** Rejected: an empty violation set
is legitimate on a complete, green scan of a repo whose debt was genuinely all fixed. The store
cannot distinguish the two cases — only the run's verdict can — and pushing the check down into
core would require core to know about run completeness, which is the CLI's concern.

**Guard each mutating site independently.** Rejected on the evidence: independent guarding is
precisely how this became five copies. One shared function is the point.

**Treat `complete: false` exactly like an errored run — refuse with no override.** Rejected: it
would make `align baseline prune` permanently unusable on any repo that cannot reach a complete
install, with no path forward. A rule users cannot satisfy is a rule they route around.

**Warn on `complete: false` and prune anyway.** Rejected: it preserves the exact defect this ADR
exists to eliminate, downgraded to a message. A warning printed above a success line and an
`exit 0` is not a control — the whole finding here is that these paths *reported success* while
destroying data.

## Consequences

- `align baseline prune` and `align init` now exit non-zero on an errored scan instead of
  succeeding destructively. This is a behaviour change users may notice; it converts silent data
  loss into a loud refusal.
- **`align baseline prune` also stops deleting on an incomplete scan without `--allow-incomplete`.
  This affects real repos today** — `test-apps/n8n` is `complete: false` — so anyone pruning a
  repo with an incomplete dependency install must now either complete the install or pass the
  flag. That is the intended cost: those are precisely the runs whose "fixed" verdicts were never
  verified.
- Any future command that **destructively** mutates state from gate violations must call
  `refuseIfRunErrored`. This is the reviewable rule — a new destructive consumer that does not
  call it is a defect by definition, which is what makes the class detectable in review rather
  than only in production. A new *add-only* or *transfer-only* consumer is exempt, but the
  exemption must be pinned by a test the way the two existing ones are; an unpinned exemption is
  an assertion, and assertions are how this class reached five copies.
- The three reporting sites keep their existing `computeBaselineDebt` handling; this ADR does not
  merge reporting and mutation into one mechanism, because they need different outcomes (a
  qualified number vs. a refusal).

## Evidence

- Reproduced end-to-end, output verbatim above (2026-08-08).
- `packages/cli/src/errored-run.ts:4-34` records the mechanism, both destructive cases, and the
  `knownFiles` non-catch, at the point of enforcement.
- `packages/cli/src/commands/baseline.ts:67-76` records why `prune` specifically is the
  destructive one: it is the only command that **deletes** accepted consent decisions.
- Audit report: `.agents/research/2026-08-03-bug-hunt-full-codebase.md`, BUG #18 (rated Critical).
- Doctrine precedent: this is the "reports success wrongly" class — a false green destroys trust
  in every other signal the system emits, so it outranks correctness bugs with larger blast
  radius. Related: ADR 006 (baseline consent), ADR 008 (gate model).

## Amendment (2026-08-11): tier 2 extends to `align init` — both write paths, not one

The original Decision applied **tier 1** to `runInit` but **tier 2** only to `baselinePrune`, on the
reasoning that changing `init`'s contract was out of scope. That left an open question rather than a
settled one. Re-examining it found the exposure is larger than the single branch that prompted it.

`init` never reads the baseline it overwrites, and `writeBaseline` (`align-dir.ts:206`) is a full
replace. So **both** of `init`'s write paths destroy accepted entries on a `complete: false` scan.
Reproduced 2026-08-11 against the `simple-app-violation-incomplete` fixture (a real
`missing-dependencies` advisory, **no** errored gate — tier 1 does not fire), output verbatim:

**Zero-violations path** (`commands/init.ts:162`) — the branch this amendment was opened on:

```
baseline BEFORE: 1 entries
Initial check is green — no baseline seeding needed.
init exit: 0
baseline AFTER:  0 entries
```

**Seed path** (`commands/init.ts:195`, under `--accept-existing`) — **not previously identified**,
and not covered by any tier. The write persists only the violations the *current* scan observed, so
an accepted entry the scan can no longer see is silently dropped:

```
baseline BEFORE: 2 entries [b26ffb86.../manual@1700000000000, deadbeef.../manual@1700000000000]
Seeded baseline with 1 pre-existing violation(s)
init exit: 0
baseline AFTER:  1 entries [b26ffb86.../accept-existing@1786480306952]
```

Both are the shape this ADR exists to eliminate: silent data loss, reported as success, exit 0.

The realistic trigger is not exotic. Missing dependencies drop *external* edges, so a monorepo whose
cross-package imports resolve through `node_modules` loses every cross-package edge when the install
is absent — and with them every `arch.layers`/`arch.no-dependency` violation routed through one. The
scan then reads green, and a re-run of `init` wipes the baseline. That is a fresh clone plus a
re-run, on exactly the class of repo that carries a baseline worth protecting.

### Decision

**Tier 2 applies to `align init`'s baseline write, at both paths, through one guard.**

- **At-risk count** = existing on-disk entries whose fingerprint is absent from the entry set the
  write would persist. The zero-violations path yields every existing entry; the seed path yields
  the entries the scan no longer observes; a first `init` on a repo with no baseline yields 0 and is
  never refused. One formula, both paths — the branch is not part of the decision.
- **One call site.** Exactly one helper inside `commands/init.ts` computes the count and calls
  `refuseIfRunIncomplete`; both write paths route through it. Guarding each path independently is
  precisely how this class reached five copies, and this ADR's own Alternatives already rejected it.
- **`--allow-incomplete` on `align init`**, identical in name, semantics, and refusal text to
  `align baseline prune` and `align upgrade`. `init` becomes the third tier-2 consumer.
- **A complete scan behaves exactly as it does today.** Dropping an entry whose violation a complete
  scan verified as gone is correct prune semantics, not a defect.
- **`init` must read the baseline before overwriting it**, with the same corrupt-≠-absent discipline
  every other baseline consumer already applies (`tryReadBaseline`, `commands/baseline.ts:17-24`).
  A corrupt `.align/baseline.json` is refused rather than silently replaced — the last remaining
  silent-overwrite path. Recovery stays explicit and available: repair or delete the file, re-run.

### Alternatives considered (this amendment)

**Guard only the zero-violations path** — the question as originally posed. Rejected on the evidence
above: the seed path destroys entries under the identical condition, and shipping a guard that
covers one of two identical paths is how the next audit finds copy number six.

**Require an `--accept-existing`-style confirmation for a `complete: false` + zero-violations run.**
Rejected: it invents a second consent mechanism for a hazard the existing guard already models, and
it does not reach the seed path at all.

**Refuse any `init` that would overwrite an existing baseline, regardless of completeness.** The
most principled reading — "initialize" should arguably not mean "reset" — but it breaks the
re-runnable-`init` flow this codebase documents and tests, and on a complete scan the overwrite is
correct. Recorded as the stronger invariant available if re-running `init` on an initialized repo is
ever reconsidered as a whole.

**Merge instead of replace, refusing only the deletion half** — the shape `align upgrade` already
uses, where adds proceed while deletes refuse (`commands/upgrade.ts:330-335`). This is the better
end state and it also fixes the provenance loss below. It was initially deferred as a contract change
rather than a completeness guard; it was then taken up the same day, and the section below records
what it became.

### Resolved (same day): the seed path preserves provenance

Independent of completeness, the seed path rewrote every surviving entry's `acceptedAt` to now and
its `acceptedBy` to `init-seed`/`accept-existing` — visible in the reproduction above, where a
`manual@1700000000000` acceptance came back as `accept-existing@1786480306952`. That erased the
audit trail of a consent decision ADR 006 treats as the human's, on every re-run, including on a
complete scan where nothing else was lost. Losing *who accepted this, and when* is a smaller harm
than losing the entry, but it is the same kind of harm, and it happened on every re-run rather than
only on an incomplete scan.

**Decision: the seed path merges rather than replaces.** For each violation the scan observed, an
existing baseline entry with the same fingerprint contributes its original `acceptedAt` and
`acceptedBy`; only a genuinely new violation is stamped `init-seed`/`accept-existing` at now.

Two details the merge must get right, both consequences of what a fingerprint is:

- **`ruleId` and `file` come from the current violation, never from the prior entry.** Fingerprints
  are content-snippet hashes, not line numbers or paths (ADR 006), so a violation whose file MOVED
  keeps its fingerprint. Carrying the prior entry over verbatim would persist a stale path — the
  exact drift `store.reconcileMoves` exists to prevent. Only the provenance pair is inherited.
- **Entries the scan did not observe are still dropped**, exactly as before, and still gated by the
  tier-2 guard above. Preserving them unconditionally would make `init` unable to ever clear fixed
  debt, and on a complete scan dropping them is correct prune semantics — the same reasoning that
  kept complete scans unchanged in the main Decision. So this is a merge of *provenance*, not a
  union of *entries*: the deletion half remains governed by completeness, the add half no longer
  destroys history.

`init` therefore stops rewriting consent records it did not author. What it still does on a complete
scan — drop entries whose violations are genuinely gone — is unchanged and intended.

### Consequences (in addition to the original)

- `align init` exits non-zero, changing nothing, on an incomplete scan that would drop accepted
  entries — where it previously exited 0 having destroyed them. Overridable with
  `--allow-incomplete`.
- `align init` gains a flag, and the original Decision's "Applied at both destructive sites"
  now reads: tier 1 at `baselinePrune` and both `runInit` paths; tier 2 at `baselinePrune`,
  `align upgrade`'s prune half, and both `runInit` paths.
- `align init` on a corrupt `.align/baseline.json` now refuses instead of overwriting it.
- `align init`'s seed path no longer rewrites `acceptedAt`/`acceptedBy` on entries it did not
  author; re-running `init` on an initialized repo preserves the consent record's audit trail. New
  violations are still stamped `init-seed`/`accept-existing`, and entries the scan did not observe
  are still dropped under the completeness rules above.
