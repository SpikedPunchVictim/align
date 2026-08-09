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
