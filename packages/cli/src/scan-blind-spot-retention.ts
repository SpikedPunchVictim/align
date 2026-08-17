import { blindSpotsCovering, describeBlindSpotReason, isUnderBlindSpot, type RepoRelativePath, type ScanBlindSpot } from '@spikedpunch/align-core';

/**
 * Shared "unobservable, not fixed" test for the two destructive baseline-write consumers
 * (`align baseline prune`, `align init`) — the retention half of ADR 023's own vocabulary, applied
 * to a hazard ADR 023 itself doesn't cover: a scan that declined to look at part of the repository.
 *
 * ADR 023's `complete`/`isRunComplete` axis only fires on a `missing-dependencies` advisory
 * (unresolved external specifiers). A blind spot (`CheckRun.blindSpots` — an auto-excluded nested
 * checkout, an `excludes` match, a `node_modules`-class directory name, an unreadable directory, a
 * symlink) drops files from the scan the exact same way a missing dependency drops edges — a
 * baseline entry for a file under one looks orphaned to `store.prune`/`init`'s at-risk computation
 * for a reason that has nothing to do with the violation being fixed — but it does NOT set
 * `complete: false`, so ADR 023's tier-2 guard alone does not protect it. This module is the one
 * place both consumers test "is this entry's file inside a path this scan couldn't see," so the test
 * can't drift into two independently-maintained copies (CLAUDE.md rule 6: hunt the class).
 *
 * Deliberately narrower than ADR 023's tier 2: unlike "some dependency somewhere is missing" (which
 * taints the WHOLE run's completeness), a blind spot names its own path precisely — we know exactly
 * which entries are affected, so only THOSE are retained. Every other orphan in the same run is
 * still safe to prune/drop normally; an all-or-nothing refusal would be needless here.
 *
 * The underlying "is this file inside one of these paths" containment test (`isUnderBlindSpot`)
 * lives in `@spikedpunch/align-core` rather than here, because `InMemoryBaselineStore.applyMoves`
 * (`packages/core/src/baseline/store.ts`) needs the identical test for a second hazard this module
 * doesn't cover by itself: an unobserved orphan being misclassified as "moved" rather than
 * "removed" (ADR 027's F1, generalized by ADR 028) — `applyMoves` bypasses this module's
 * `retained`/`forfeited` partition entirely, since a "moved" entry never reaches it. One
 * implementation, imported here and by `store.ts`, keeps the two consumers from drifting into
 * independently-maintained copies.
 */
export interface BlindSpotRetentionSplit<T> {
  /** File lives at or under a recorded blind spot — unobservable this scan, not fixed. Never
   * delete; the caller must carry these forward into whatever it persists. */
  readonly retained: readonly T[];
  /** Every other candidate — the destructive write's normal path (delete/omit as before). */
  readonly forfeited: readonly T[];
}

/**
 * Partitions `candidates` (baseline entries a destructive write is about to drop) into `retained`
 * (file under a blind spot) and `forfeited` (everything else, safe to drop as before).
 * `blindSpots.length === 0` short-circuits to "everything forfeited" without a comparison per
 * candidate — though unlike the pre-ADR-028 checkout-only version, that is no longer the
 * overwhelmingly common case: every repo has a `node_modules`, so a real scan records blind spots
 * on essentially every run. The retention decision still turns on whether an entry's file is
 * actually under one.
 */
export function partitionBlindSpotCandidates<T extends { readonly file: RepoRelativePath }>(
  candidates: readonly T[],
  blindSpots: readonly ScanBlindSpot[],
): BlindSpotRetentionSplit<T> {
  if (blindSpots.length === 0) return { retained: [], forfeited: candidates };
  const retained: T[] = [];
  const forfeited: T[] = [];
  for (const candidate of candidates) {
    const retain = isUnderBlindSpot(candidate.file, blindSpots);
    (retain ? retained : forfeited).push(candidate);
  }
  return { retained, forfeited };
}

/**
 * Human-readable report line for a nonzero `retained` set — shared wording so `align baseline
 * prune` and `align init` describe the identical hazard identically. Names only the blind spots that
 * actually own a retained entry (not every path this scan skipped), so the message stays precise in
 * a repo whose scan records dozens of them and only one is why entries were retained.
 *
 * ADR 028 §3: the reason is printed, never just the count. Silent retention converts a false-delete
 * into a false-tranquility — a misconfigured near-empty scan retains everything and, without
 * reasons, reads identically to "nothing to prune."
 */
export function describeRetainedEntries<T extends { readonly file: RepoRelativePath }>(
  retained: readonly T[],
  blindSpots: readonly ScanBlindSpot[],
): string {
  const relevant = [
    ...new Set(
      retained.flatMap((entry) =>
        blindSpotsCovering(entry.file, blindSpots).map((spot) => `${spot.path} (${describeBlindSpotReason(spot.reason)})`),
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const one = retained.length === 1;
  const hasCheckout = retained.some((entry) =>
    blindSpotsCovering(entry.file, blindSpots).some((spot) => spot.reason.kind === 'nested-checkout'),
  );
  return (
    `Retained ${retained.length} ${one ? 'entry' : 'entries'}: ${one ? 'its file is' : 'their files are'} ` +
    `under path(s) this scan did not look at (${relevant.join(', ')}), so ` +
    `${one ? 'that violation is' : 'those violations are'} unobservable, not fixed.` +
    // Only the nested-checkout reason has a config-level way back in — see the same restraint in
    // `core/src/components/registry.ts`. Pointing a user at `includeNestedCheckouts` to recover
    // from a symlink or an unreadable directory would send them to a setting that cannot help.
    (hasCheckout ? " Add the checkout(s) to align.config.ts's includeNestedCheckouts export to prune them." : '')
  );
}
