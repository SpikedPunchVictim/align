import type { CheckRun, ComponentName } from '@spikedpunch/align-core';
import { describeErroredGates, isRunComplete } from '@spikedpunch/align-core';
import { reportCliError } from './cli-error.js';
import type { ScanHistory } from './scan-history.js';

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
 * Neither could catch it downstream, and the reason is now structural rather than incidental. Until
 * ADR 028 Stage 3 the file set came from `orchestrator.knownFiles`, a SECOND walk that only scanned:
 * it never ran `validateSelectorSyntax`/`validateClassifiedComponents`/`validateRuleComponentRefs`/
 * `validateHostRules` or rule evaluation — the actual error sources in `check()` — so a run that
 * errored in `check()` still yielded a perfectly healthy-looking file set, and the two disagreed
 * with nothing to notice it. That method is gone; the set now comes off the same `CheckRun` this
 * guard inspects, so "the scan errored" and "here is what the scan saw" can no longer come from
 * different walks. The guard is still required — an errored run reports `violations: []` without
 * having evaluated anything, which is the whole defect — but it now guards one set of facts instead
 * of arbitrating between two. There is no override: an errored scan evaluated NO rules at all, so
 * there is nothing a user could knowingly consent to.
 *
 * **Tier 2 — `refuseIfRunIncomplete`, below.** `complete: false` (`isRunComplete`,
 * `gates/advisories.ts` — the shared predicate, also used by the MCP payload builder's `complete`
 * field) means this scan evaluated less than the repository contains. Its first axis is a
 * `missing-dependencies` advisory: the graph was built without some of the
 * repo's dependencies, dropping edges. A cycle or dependency routed through a dropped edge becomes
 * UNOBSERVABLE, not fixed, so a baseline entry that looks orphaned on an incomplete scan might just
 * be unverified. Unlike tier 1, this scan DID evaluate real rules, so its results are partially
 * meaningful — deletion refuses by default (naming the count at risk) but is overridable with
 * `--allow-incomplete`, because some repos can't practically reach a complete install and a rule
 * with no escape hatch just gets routed around.
 *
 * The two tiers now OVERLAP rather than partition: since LEDGER D043 `isRunComplete` is also false
 * for an errored run, so an errored run is refused by whichever guard it meets. The tiers are still
 * ordered, not merged — tier 1 is the correct answer for an errored run because it cannot be
 * overridden, and both call sites reach it first, which is what keeps `--allow-incomplete` from
 * becoming a way to prune off a crashed scan. Tier 2's errored branch exists only so a future site
 * that somehow reaches it alone refuses with the right reason instead of the wrong one.
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
  // `describeErroredGates` (core) rather than the local join this used to build — `packages/agent`
  // had grown an identical copy and the MCP surface needed a third (LEDGER D047).
  const detail = describeErroredGates(run);
  return reportCliError(
    command,
    new Error(
      // No `|| 'a gate errored'` fallback: `deriveVerdict` sets `verdict: 'error'` only when some
      // gate has `status: 'error'`, and `describeErroredGates` renders a message-less gate as
      // "<gate> gate: unknown error" — so this is never empty on the path that reaches it.
      `${refusal} — this scan did not complete, so its empty violation set means "not verified", never "fixed". ` +
        detail,
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
 * sites (`baselinePrune` and `reconcilePrune`'s preview of it) already have to compute it to do
 * their own work — and it is NOT simply `store.prune`'s `removed.length`: both derive it as the
 * `forfeited` half of `partitionBlindSpotCandidates`, since an entry retention writes straight
 * back was never at risk of deletion (verified 2026-08-13, when the preview still used the raw
 * `removed.length` and refused over entries the mutation would have retained); this
 * function stays a pure decision (`CheckRun` × count × flag → refuse or not) rather than reaching
 * into a `BaselineStore` itself, keeping it usable from any future destructive site regardless of
 * what kind of store or overwrite it performs.
 *
 * Returns a non-zero exit code (printing the count at risk and the reason) when the scan is
 * incomplete, the count is nonzero, and the override wasn't passed; `undefined` otherwise —
 * mirroring `refuseIfRunErrored`'s "undefined means proceed" contract so both guards compose the
 * same way at a call site.
 */
export function refuseIfRunIncomplete(
  command: string,
  run: CheckRun,
  atRiskCount: number,
  allowIncomplete: boolean,
  /**
   * The previous scan — ADR 029 §6's grounding and scope-change consumers, wired 2026-08-19.
   *
   * Purely for the MESSAGE. The refusal is decided by `isRunComplete` and is unchanged, which is
   * exactly what §6 licenses here: *"the ADR 023 tier-2 refusal itself is unchanged; only its message
   * improves"*. Required rather than optional so a new call site has to state what it knows; a caller
   * with no repository to read from passes one built on `noScanHistory()` and the message degrades to
   * what it said before.
   */
  history: ScanHistory,
): number | undefined {
  if (atRiskCount === 0 || isRunComplete(run) || allowIncomplete) return undefined;
  // `isRunComplete` now has two axes (LEDGER D011), and telling a user to install dependencies when
  // the real problem is a component selector pointing at a directory that no longer exists sends
  // them somewhere they cannot fix it. Name the axis that actually fired.
  const ungrounded = run.ungroundedComponents;
  const reason =
    run.verdict === 'error'
      ? // Unreachable from either call site today — tier 1 refuses an errored run first, without an
        // override, and both sites call it first. Written anyway because `isRunComplete` gained the
        // errored axis (LEDGER D043) and a future site that reaches only this guard must not be told
        // to install dependencies when a gate crashed. Same reason the ungrounded branch above
        // exists: naming the wrong axis sends the user somewhere they cannot fix it.
        'a gate errored, so this scan evaluated no rules at all and every absent violation is unverified rather ' +
        'than fixed. Fix the gate error reported above (`align check` prints it)'
      : ungrounded.length > 0
      ? `${ungrounded.length} declared component(s) matched no files (` +
        `${ungrounded
          .map((c) => `${c.name} → '${c.selector}'${describeGroundingHistory(history, c.name)}`)
          .slice(0, 3)
          .join(', ')}${ungrounded.length > 3 ? `, +${ungrounded.length - 3} more` : ''}), so every rule scoped to ` +
        'them evaluated over nothing and their violations are unobservable rather than fixed. Check those selectors ' +
        `against the tree${describeScopeChange(history)}`
      : 'this scan could not resolve all dependencies (missing-dependencies advisory), so an absent violation may be ' +
        'unobservable rather than fixed. Re-run with dependencies installed';
  return reportCliError(
    command,
    new Error(
      `refusing to delete ${atRiskCount} ${atRiskCount === 1 ? 'entry' : 'entries'} — ${reason}, or pass ` +
        '--allow-incomplete.',
    ),
  );
}

/**
 * ADR 029 §6's grounding consumer (LEDGER D011). "matched no files" is equally true of a component
 * that never matched anything and of one that matched twelve yesterday — and only the second is a
 * regression. The first is a selector that was always wrong; the second is a tree that moved. Naming
 * which one turns a refusal the user has to investigate into one they can act on.
 *
 * Silent when the history cannot speak, and silent when the previous count was also zero: a message
 * that appends "(matched 0 files last scan)" to every ungrounded component is adding noise to the
 * sentence it exists to sharpen.
 */
function describeGroundingHistory(history: ScanHistory, component: ComponentName): string {
  const before = history.probe.observedMatchCount(component);
  if (!before.known || before.value === 0) return '';
  return ` — matched ${before.value} file(s) on the previous scan and 0 now`;
}

/**
 * ADR 029 §6's scope-change consumer (D009), **direction-free — a correction to §6 rather than a
 * shortcut.** §6 says "report the narrowing direction only", and the record cannot support it:
 * `scopeIdentity` is a hash over the sorted `excludes` plus the nested-checkout opt-outs, so comparing
 * two of them yields same-or-different and never narrower-or-wider. Reporting a direction would mean
 * carrying the scope's CONTENTS in every repository — the same bytes-for-a-message trade LEDGER D032
 * has just declined for the observed-file list, and declined after measuring it at 64% of the record.
 *
 * "Different" is still worth saying, because it is the single fact that most often explains an
 * ungrounded component: somebody edited `excludes`.
 */
function describeScopeChange(history: ScanHistory): string {
  const previous = history.probe.previousScopeIdentity();
  if (!previous.known || previous.value === history.context.scopeIdentity) return '';
  return ' (note: the scan scope changed since the previous run)';
}
