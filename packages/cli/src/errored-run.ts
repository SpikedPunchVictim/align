import type { CheckRun } from '@spikedpunch/align-core';
import { isRunComplete } from '@spikedpunch/align-core';
import { reportCliError } from './cli-error.js';

/**
 * The two guards every command that MUTATES state from a `CheckRun`'s violations must pass through
 * (bug hunt 2026-08-08, BUG #18, and ADR 023) — the fourth and fifth copies of the errored-gate
 * asymmetry that `computeBaselineDebt` (`commands/check.ts`) documents for the three *reporting*
 * sites, plus a second, independent axis ADR 023 adds: a run can fail to see everything WITHOUT
 * erroring.
 *
 * **Tier 1 — `refuseIfRunErrored`, below.** An errored gate reports `violations: []` and
 * `baselinedCount: 0` (`orchestrator.ts` builds `errorGate(err, …)` and returns immediately, before
 * any rule is evaluated), so on an `error` verdict EVERY violation is absent from the run. Absent
 * means "this scan never verified it" — it NEVER means "fixed". A reporting site that misreads the
 * difference prints a wrong number; a MUTATING site destroys data:
 *
 *   - `baseline prune` deleted every accepted entry (they all looked orphaned, and `store.prune`'s
 *     post-FRAGILE-#7 rule deletes an orphan whose file is still present), printing
 *     "Pruned N fixed violation(s)" and exiting 0.
 *   - `init` wrote `[]` over an existing baseline and printed "Initial check is green".
 *
 * Neither could catch it downstream: `orchestrator.knownFiles` only re-scans — it never runs
 * `validateSelectorSyntax`/`validateClassifiedComponents`/`validateRuleComponentRefs`/
 * `validateHostRules` or rule evaluation, which are the error sources in `check()`, so a run that
 * errors in `check()` yields a perfectly healthy `knownFiles`. There is no override: an errored
 * scan evaluated NO rules at all, so there is nothing a user could knowingly consent to.
 *
 * **Tier 2 — `refuseIfRunIncomplete`, below.** `complete: false` (`isRunComplete`,
 * `gates/advisories.ts` — the shared predicate, also used by the MCP payload builder's `complete`
 * field) means a `missing-dependencies` advisory fired: the graph was built without some of the
 * repo's dependencies, dropping edges. A cycle or dependency routed through a dropped edge becomes
 * UNOBSERVABLE, not fixed, so a baseline entry that looks orphaned on an incomplete scan might just
 * be unverified. Unlike tier 1, this scan DID evaluate real rules, so its results are partially
 * meaningful — deletion refuses by default (naming the count at risk) but is overridable with
 * `--allow-incomplete`, because some repos can't practically reach a complete install and a rule
 * with no escape hatch just gets routed around.
 *
 * Both guards: callers must call them BEFORE writing any file (tier 1, additionally, before even
 * consulting the store — see its own note below). `deriveVerdict` guarantees any errored gate ⇒
 * `verdict: 'error'`, so for tier 1 the verdict alone is the complete test.
 *
 * NOT needed by a command that only ADDS: `baseline accept` builds its store from the on-disk
 * entries and only ever calls `store.accept`, so an empty violation set makes it a no-op rewrite of
 * the same entries — verified by test, and pinned there so it stays true. Neither tier applies to
 * it, for the same reason.
 */
export function refuseIfRunErrored(command: string, run: CheckRun, refusal: string): number | undefined {
  if (run.verdict !== 'error') return undefined;
  const detail = run.gates
    .filter((g) => g.status === 'error')
    .map((g) => `${g.gate} gate: ${g.errorMessage ?? 'unknown error'}`)
    .join('; ');
  return reportCliError(
    command,
    new Error(
      `${refusal} — this scan did not complete, so its empty violation set means "not verified", never "fixed". ` +
        `${detail || 'a gate errored'}`,
    ),
  );
}

/**
 * ADR 023 tier 2: refuses a DESTRUCTIVE mutation (deletion, or a full baseline overwrite) computed
 * from an incomplete scan's violations, unless the caller passed `--allow-incomplete`. Gates
 * DELETION only — a transfer or an add cannot destroy a consent decision, which is the thing this
 * guard protects, so a caller with zero entries actually at risk (`atRiskCount === 0`) is never
 * refused even on `complete: false` (a pure move-transfer, or a no-op, proceeds unconditionally).
 *
 * `atRiskCount` is supplied by the caller rather than recomputed here because the two current call
 * sites already have to compute it to do their own work (`store.prune`'s `removed.length`); this
 * function stays a pure decision (`CheckRun` × count × flag → refuse or not) rather than reaching
 * into a `BaselineStore` itself, keeping it usable from any future destructive site regardless of
 * what kind of store or overwrite it performs.
 *
 * Returns a non-zero exit code (printing the count at risk and the reason) when the scan is
 * incomplete, the count is nonzero, and the override wasn't passed; `undefined` otherwise —
 * mirroring `refuseIfRunErrored`'s "undefined means proceed" contract so both guards compose the
 * same way at a call site.
 */
export function refuseIfRunIncomplete(command: string, run: CheckRun, atRiskCount: number, allowIncomplete: boolean): number | undefined {
  if (atRiskCount === 0 || isRunComplete(run) || allowIncomplete) return undefined;
  return reportCliError(
    command,
    new Error(
      `refusing to delete ${atRiskCount} ${atRiskCount === 1 ? 'entry' : 'entries'} — this scan could not resolve ` +
        'all dependencies (missing-dependencies advisory), so an absent violation may be unobservable rather than ' +
        'fixed. Re-run with dependencies installed, or pass --allow-incomplete.',
    ),
  );
}
