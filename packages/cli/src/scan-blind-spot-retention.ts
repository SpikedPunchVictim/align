import { blindSpotsCovering, describeBlindSpotReason, type FileExistenceProbe, type RepoRelativePath, type ScanBlindSpot } from '@spikedpunch/align-core';

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
 * The containment test (`blindSpotsCovering`) lives in `@spikedpunch/align-core` rather than here,
 * because `InMemoryBaselineStore.applyMoves` (`packages/core/src/baseline/store.ts`) needs the
 * identical test for a second hazard this module doesn't cover by itself: an unobserved orphan being
 * misclassified as "moved" rather than "removed" (ADR 027's F1, generalized by ADR 028) —
 * `applyMoves` bypasses this module's `retained`/`forfeited` partition entirely, since a "moved"
 * entry never reaches it. One implementation, imported here and by `store.ts`, keeps the two
 * consumers from drifting into independently-maintained copies.
 *
 * STAGE 2 ADDS THE SECOND MECHANISM HERE, not only in the store, and the reason is `align init`.
 * `init`'s destructive drop path never calls `store.prune` — it filters its existing entries against
 * the fingerprints it is about to persist (`commands/init.ts`) — so a guard living only in the store
 * would protect `prune` and miss `init` entirely. That is the exact fix-one-arm-miss-the-other shape
 * ADR 027's F1 was, and putting retention in core instead would have forced `init` to grow a second
 * implementation of it. Both destructive consumers partition through THIS function, with the same
 * probe, so there is one answer to "may align drop this entry" and one place to change it.
 */

/** Why a candidate was retained. Carried on the split rather than recomputed by the reporter,
 * because the two reasons are not interchangeable and one of them cannot be recovered after the
 * fact: a probe-retained entry has NO covering blind spot, so a reporter that re-derived the reason
 * from `blindSpots` alone would render an empty path list and tell the user nothing. */
export type RetentionReason =
  /** ADR 028 mechanism 1: the walk recorded a path covering this file, and said why. */
  | { readonly kind: 'blind-spot'; readonly spots: readonly ScanBlindSpot[] }
  /** ADR 028 mechanism 2: no blind spot covers this file, but it is still on disk. The scan was
   * narrower than the repository for a reason nobody enumerated — the case the record structurally
   * cannot cover, and the reason the probe exists. */
  | { readonly kind: 'present-on-disk' };

export interface RetainedCandidate<T> {
  readonly candidate: T;
  readonly reason: RetentionReason;
}

export interface BlindSpotRetentionSplit<T> {
  /** Unobservable this scan, not fixed. Never delete; the caller must carry these forward into
   * whatever it persists, and must print the reason (ADR 028 §3). */
  readonly retained: readonly RetainedCandidate<T>[];
  /** Every other candidate — the destructive write's normal path (delete/omit as before). */
  readonly forfeited: readonly T[];
}

/**
 * Partitions `candidates` (baseline entries a destructive write is about to drop) into `retained`
 * (unobservable) and `forfeited` (safe to drop as before), applying BOTH of ADR 028's mechanisms in
 * the order that costs least: the in-memory blind-spot containment test first, the filesystem probe
 * only for candidates it did not already cover.
 *
 * `observedFiles` is what the scan actually saw — see the comment on the probe branch for why that
 * gate is load-bearing rather than an optimisation.
 *
 * There is no short-circuit on `blindSpots.length === 0` any more, and its removal is deliberate:
 * the pre-Stage-2 version returned "everything forfeited" without looking at a single candidate,
 * which is now exactly wrong — a scan can record no blind spot at all and still be narrower than
 * the repository, and that residue is the entire reason mechanism 2 exists.
 */
export function partitionBlindSpotCandidates<T extends { readonly file: RepoRelativePath }>(
  candidates: readonly T[],
  blindSpots: readonly ScanBlindSpot[],
  observedFiles: ReadonlySet<RepoRelativePath>,
  fileExists: FileExistenceProbe,
): BlindSpotRetentionSplit<T> {
  const retained: RetainedCandidate<T>[] = [];
  const forfeited: T[] = [];
  for (const candidate of candidates) {
    const spots = blindSpotsCovering(candidate.file, blindSpots);
    if (spots.length > 0) {
      retained.push({ candidate, reason: { kind: 'blind-spot', spots } });
      continue;
    }
    // `!observedFiles.has(...)` is the PRECONDITION, not an optimisation, and leaving it out is a
    // severity-zero in the opposite direction — caught by `nested-checkout-scan-scope.test.ts` when
    // it was left out. Every scanned file also exists on disk, so an unconditional probe retains
    // every genuinely-fixed violation in a file that still exists, which is nearly all of them:
    // `prune` becomes a permanent no-op and the baseline can only ever grow. ADR 028's wording is
    // exact — "an orphan whose file is ABSENT FROM THE SCAN is additionally checked against the
    // filesystem". A file the walk DID observe, carrying no violation this run, was genuinely
    // fixed; that is the one sound deletion and the probe must not veto it.
    if (!observedFiles.has(candidate.file) && fileExists(candidate.file)) {
      retained.push({ candidate, reason: { kind: 'present-on-disk' } });
      continue;
    }
    forfeited.push(candidate);
  }
  return { retained, forfeited };
}

/** The entries themselves, for the caller that has to persist them. Kept as a named helper so the
 * `.map` does not get written three different ways at the three call sites that need it. */
export function retainedEntries<T>(retained: readonly RetainedCandidate<T>[]): readonly T[] {
  return retained.map((r) => r.candidate);
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
  retained: readonly RetainedCandidate<T>[],
): string {
  const causes = [
    ...new Set(
      retained.flatMap((r) =>
        r.reason.kind === 'blind-spot'
          ? r.reason.spots.map((spot) => `${spot.path} (${describeBlindSpotReason(spot.reason)})`)
          : // Named per FILE, not per path-prefix: there is no recorded path to blame, and the file
            // itself is the only fact align has. Saying so plainly is the point — this is the arm
            // that fires when align cannot explain why its own scan missed something.
            [`${r.candidate.file} (still on disk, but this scan produced no result for it)`],
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));
  // Capped like every other list align prints (`gates/advisories.ts`'s `describePaths`,
  // `unverified-prune.ts`'s `describeUnverifiablePrunes`). Uncapped, the probe arm names one cause
  // PER FILE, so the bulk-retention case this stage makes reachable — ADR 028's own cross-version
  // extension-set story — would print a line naming every entry in the baseline. Stage 1 shipped
  // exactly this defect in `validateComponents` and it was caught in review; not repeating it.
  const shown = causes.slice(0, 5);
  const moreCauses = causes.length - shown.length;
  const one = retained.length === 1;
  const hasCheckout = retained.some(
    (r) => r.reason.kind === 'blind-spot' && r.reason.spots.some((spot) => spot.reason.kind === 'nested-checkout'),
  );
  return (
    `Retained ${retained.length} ${one ? 'entry' : 'entries'}: ${one ? 'its file is' : 'their files are'} ` +
    `unobservable this scan, not fixed (${shown.join(', ')}${moreCauses > 0 ? `, +${moreCauses} more` : ''}).` +
    // Only the nested-checkout reason has a config-level way back in — see the same restraint in
    // `core/src/components/registry.ts`. Pointing a user at `includeNestedCheckouts` to recover
    // from a symlink or an unreadable directory would send them to a setting that cannot help.
    (hasCheckout ? " Add the checkout(s) to align.config.ts's includeNestedCheckouts export to prune them." : '')
  );
}
