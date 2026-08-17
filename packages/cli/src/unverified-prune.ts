/**
 * Reporting for prune deletions align could not actually verify as "fixed".
 *
 * `align baseline prune` removes an accepted entry when its violation is absent from the current
 * scan, and prints the count as "Pruned N fixed violation(s)". For most entries that word is
 * earned. For one specific shape it is not, and this module names that shape so the output stops
 * claiming a check it never performed (CLAUDE.md rule 6: "reports success wrongly" is the
 * severity-zero class, and the fix for a wrong report can be an accurate report).
 *
 * THE SHAPE. An entry qualifies when BOTH hold:
 *
 *   1. it carries no `contentFingerprint`, and
 *   2. its file is gone from the current scan.
 *
 * Condition 2 is what makes condition 1 matter. `applyMoves` (core's `store.ts`) only offers an
 * orphan for move-transfer once its own file has genuinely disappeared (FRAGILE #7) — while the
 * file is still in `knownFiles`, an absent violation really does mean fixed, and the missing
 * fingerprint changes nothing. It is when the file has vanished that "renamed" and "deleted"
 * become indistinguishable, and `contentFingerprint` (ruleId + snippet, path-independent) is the
 * only thing that could tell them apart. Without it the entry cannot match any candidate, so it
 * falls through to `unmatchedOrphans` and is deleted — as "fixed", unverified.
 *
 * WHY ENTRIES LACK IT. `baseline accept` has always written the field; `align init` never has, in
 * any release, so every init-seeded entry qualifies. Baselines written before the field existed
 * qualify too (it is optional in `baseline/schema.ts` precisely so those still parse). Until the
 * 2026-08-14 fix, re-running `init` also STRIPPED the field from entries `accept` had written,
 * which is how an entry could regress into this shape without anyone touching the baseline by hand.
 *
 * WHY REPORT RATHER THAN RETAIN. Retention is the right instrument when the condition is
 * recoverable — `scan-blind-spot-retention.ts` retains entries under a scan blind spot because the
 * scan can be made to see those paths again (opting a checkout back in, fixing permissions, widening
 * `excludes`). There is no equivalent exit here: nothing restores a
 * `contentFingerprint` to an entry whose violation the scan can no longer see, so retaining these
 * would accumulate un-prunable entries forever and quietly break prune for init-onboarded repos.
 * The deletion is very likely correct; what was wrong was calling it verified.
 */
import type { RepoRelativePath } from '@spikedpunch/align-core';

/** The subset of a baseline entry this module needs. Structural, like
 * `partitionBlindSpotCandidates`'s, so callers pass their own entry type unchanged. */
export interface PruneVerifiabilityCandidate {
  readonly file: RepoRelativePath;
  readonly contentFingerprint?: string;
}

/**
 * Of the entries prune is about to delete, the ones whose deletion could not be checked against a
 * possible file move. See this module's doc comment for why both conditions are required — testing
 * `contentFingerprint` alone would over-report every init-seeded entry in the far more common case
 * where its file is still present and "fixed" is a sound conclusion.
 */
export function selectUnverifiablePrunes<T extends PruneVerifiabilityCandidate>(
  forfeited: readonly T[],
  knownFiles: ReadonlySet<RepoRelativePath>,
): readonly T[] {
  return forfeited.filter((entry) => entry.contentFingerprint === undefined && !knownFiles.has(entry.file));
}

/**
 * The advisory line for `selectUnverifiablePrunes`'s result. States what align did not check and
 * why, and deliberately offers no remediation — there is no action that would have made this
 * deletion verifiable after the fact, and inventing one would be worse than the honest gap.
 */
export function describeUnverifiablePrunes<T extends PruneVerifiabilityCandidate>(entries: readonly T[]): string {
  const files = [...new Set(entries.map((e) => e.file))].sort();
  const shown = files.slice(0, 5);
  const more = files.length - shown.length;
  const one = entries.length === 1;
  return (
    `  note: ${entries.length} of those entries carried no content fingerprint and ` +
    `${one ? 'its file is' : 'their files are'} gone from this scan, so align could not tell a rename from a fix — ` +
    `${one ? 'it is' : 'they are'} removed as fixed without that check. Entries seeded by \`align init\`, or written ` +
    'before the field existed, carry none.\n' +
    `    ${shown.join('\n    ')}${more > 0 ? `\n    +${more} more` : ''}`
  );
}
