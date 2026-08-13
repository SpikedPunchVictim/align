import { isUnderSkippedCheckout, type RepoRelativePath } from '@spikedpunch/align-core';

/**
 * Shared "unobservable, not fixed" test for the two destructive baseline-write consumers
 * (`align baseline prune`, `align init`) — the retention half of ADR 023's own vocabulary, applied
 * to a hazard ADR 023 itself doesn't cover: task #25's nested-checkout auto-exclusion.
 *
 * ADR 023's `complete`/`isRunComplete` axis only fires on a `missing-dependencies` advisory
 * (unresolved external specifiers). A nested git checkout auto-excluded from the scan
 * (`CheckRun.skippedNestedCheckouts`) drops edges the exact same way a missing dependency does —
 * a baseline entry for a file inside one looks orphaned to `store.prune`/`init`'s at-risk
 * computation for a reason that has nothing to do with the violation being fixed — but it does NOT
 * set `complete: false`, so ADR 023's tier-2 guard alone does not protect it. This module is the
 * one place both consumers test "is this entry's file inside a path this scan couldn't see," so
 * the test can't drift into two independently-maintained copies (CLAUDE.md rule 6: hunt the class).
 *
 * Deliberately narrower than ADR 023's tier 2: unlike "some dependency somewhere is missing" (which
 * taints the WHOLE run's completeness), a skipped nested checkout names its own paths precisely —
 * we know exactly which entries are affected, so only THOSE are retained. Every other orphan in the
 * same run is still safe to prune/drop normally; an all-or-nothing refusal would be needless here.
 *
 * The underlying "is this file inside one of these paths" containment test (`isUnderSkippedCheckout`)
 * lives in `@spikedpunch/align-core` rather than here, because `InMemoryBaselineStore.applyMoves`
 * (`packages/core/src/baseline/store.ts`) needs the identical test for a second hazard this module
 * doesn't cover by itself: a checkout-resident orphan being misclassified as "moved" rather than
 * "removed" (F1, review 2026-08-12) — `applyMoves` bypasses this module's `retained`/`forfeited`
 * partition entirely, since a "moved" entry never reaches it. One implementation, imported here and
 * by `store.ts`, keeps the two consumers from drifting into independently-maintained copies.
 */
export interface CheckoutRetentionSplit<T> {
  /** File lives at or under a path in `skippedNestedCheckouts` — unobservable this scan, not
   * fixed. Never delete; the caller must carry these forward into whatever it persists. */
  readonly retained: readonly T[];
  /** Every other candidate — the destructive write's normal path (delete/omit as before). */
  readonly forfeited: readonly T[];
}

/**
 * Partitions `candidates` (baseline entries a destructive write is about to drop) into `retained`
 * (file inside a skipped nested checkout) and `forfeited` (everything else, safe to drop as
 * before). `skippedNestedCheckouts.length === 0` (the overwhelmingly common case — no nested
 * checkouts skipped this scan) short-circuits to "everything forfeited" without a comparison per
 * candidate.
 */
export function partitionSkippedCheckoutCandidates<T extends { readonly file: RepoRelativePath }>(
  candidates: readonly T[],
  skippedNestedCheckouts: readonly RepoRelativePath[],
): CheckoutRetentionSplit<T> {
  if (skippedNestedCheckouts.length === 0) return { retained: [], forfeited: candidates };
  const retained: T[] = [];
  const forfeited: T[] = [];
  for (const candidate of candidates) {
    const retain = isUnderSkippedCheckout(candidate.file, skippedNestedCheckouts);
    (retain ? retained : forfeited).push(candidate);
  }
  return { retained, forfeited };
}

/**
 * Human-readable report line for a nonzero `retained` set — shared wording so `align baseline
 * prune` and `align init` describe the identical hazard identically. Names only the checkout
 * path(s) that actually own a retained entry (not every `skippedNestedCheckouts` path this scan
 * saw), so the message stays precise when a repo has several nested checkouts and only some of them
 * are why entries were retained.
 */
export function describeRetainedEntries<T extends { readonly file: RepoRelativePath }>(
  retained: readonly T[],
  skippedNestedCheckouts: readonly RepoRelativePath[],
): string {
  const relevantDirs = skippedNestedCheckouts
    .filter((dir) => retained.some((entry) => isUnderSkippedCheckout(entry.file, [dir])))
    .sort((a, b) => a.localeCompare(b));
  return (
    `Retained ${retained.length} ${retained.length === 1 ? 'entry' : 'entries'}: ` +
    `${retained.length === 1 ? 'its file is' : 'their files are'} inside nested checkout(s) auto-excluded ` +
    `from this scan (${relevantDirs.join(', ')}), so ${retained.length === 1 ? 'that violation is' : 'those violations are'} ` +
    "unobservable, not fixed. Add them to align.config.ts's includeNestedCheckouts export to prune them."
  );
}
