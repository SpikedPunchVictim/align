import type { CheckRun } from '@spikedpunch/align-core';
import { reportCliError } from './cli-error.js';

/**
 * The one guard every command that MUTATES state from a `CheckRun`'s violations must pass through
 * (bug hunt 2026-08-08, BUG #18) — the fourth and fifth copies of the errored-gate asymmetry that
 * `computeBaselineDebt` (`commands/check.ts`) documents for the three *reporting* sites.
 *
 * The asymmetry: an errored gate reports `violations: []` and `baselinedCount: 0`
 * (`orchestrator.ts` builds `errorGate(err, …)` and returns immediately, before any rule is
 * evaluated), so on an `error` verdict EVERY violation is absent from the run. Absent means
 * "this scan never verified it" — it NEVER means "fixed". A reporting site that misreads the
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
 * errors in `check()` yields a perfectly healthy `knownFiles`.
 *
 * Returns a non-zero exit code (after printing the ERRORED GATE'S OWN message — they are already
 * actionable, e.g. naming the shadowed component and the `empty:` opt-out) when the run didn't
 * complete, and `undefined` when it did. Callers must call this BEFORE touching any store or
 * writing any file. `deriveVerdict` guarantees any errored gate ⇒ `verdict: 'error'`, so the
 * verdict alone is the complete test.
 *
 * NOT needed by a command that only ADDS: `baseline accept` builds its store from the on-disk
 * entries and only ever calls `store.accept`, so an empty violation set makes it a no-op rewrite of
 * the same entries — verified by test, and pinned there so it stays true.
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
