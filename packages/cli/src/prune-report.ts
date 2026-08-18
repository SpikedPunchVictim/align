import type { RepoRelativePath } from '@spikedpunch/align-core';
import type { RetainedCandidate } from './scan-blind-spot-retention.js';

/**
 * `align baseline prune`'s headline, as a pure function of the four counts the run produced.
 *
 * ADR 028 §3 requires that retention never read as success. Before Stage 4 the headline was one
 * sentence — "Pruned 0 fixed violation(s) from the baseline" — for two situations that mean opposite
 * things:
 *
 *   - **nothing was orphaned.** The baseline matches the code; there was never anything to delete.
 *   - **everything was retained.** Entries WERE orphaned, and align refused to conclude they were
 *     fixed. That is the state a misconfigured near-empty scan produces, and rendering it as "Pruned
 *     0" turns a warning into false tranquility — a user watching this number would see a healthy
 *     repo for as long as the misconfiguration lasted.
 *
 * The reasons still come from `describeRetainedEntries` on the following line; this function's only
 * job is to stop the headline itself from asserting the wrong one of the two.
 */
export function describePruneOutcome(
  forfeitedCount: number,
  retainedCount: number,
  movedCount: number,
  // Added 2026-08-17 after review. Without it this function was fed the POST-split retained count,
  // so forfeiting the only retained entry printed "Nothing to prune — no baseline entry is
  // orphaned" directly above "Forgot 1 retained entry … This consent decision is deleted". That is
  // the exact false-headline class this function exists to prevent, reintroduced by the commit that
  // added the flag — found independently by both reviewers, reproduced against the built binary.
  forgottenCount: number,
): string {
  const moves = `${movedCount} ${movedCount === 1 ? 'entry' : 'entries'} transferred (file moves).`;
  if (forfeitedCount > 0) return `Pruned ${forfeitedCount} fixed violation(s) from the baseline; ${moves}`;
  // Ordered ABOVE the retained arm: a run that forfeited entries on the user's explicit instruction
  // did something destructive, and the headline must not open with "Nothing to prune" whatever else
  // was retained alongside it.
  if (forgottenCount > 0) {
    return (
      `Pruned 0 fixed violation(s) — nothing was verified as fixed, but ${forgottenCount} retained ` +
      `${forgottenCount === 1 ? 'entry was' : 'entries were'} forfeited on your instruction (see below); ${moves}`
    );
  }
  if (retainedCount > 0) {
    return `Pruned 0 fixed violation(s) — every candidate was retained, not deleted (see below); ${moves}`;
  }
  return `Nothing to prune — no baseline entry is orphaned; ${moves}`;
}

/**
 * The `--forget-unscanned` report. Deliberately a separate line from the "Pruned N fixed violation(s)"
 * headline rather than folded into its count: a forgotten entry was NOT concluded to be fixed —
 * align still cannot see its file — it was forfeited on the user's explicit instruction. Merging the
 * two counts would let a future reader of this output believe align verified something it did not,
 * which is the exact inference ADR 028 exists to prevent.
 */
export function describeForgottenEntries<T extends { readonly file: RepoRelativePath }>(
  forgotten: readonly RetainedCandidate<T>[],
  prefix: RepoRelativePath,
): string {
  const one = forgotten.length === 1;
  const files = forgotten
    .map((f) => f.candidate.file)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 5);
  const more = forgotten.length - files.length;
  return (
    `Forgot ${forgotten.length} retained ${one ? 'entry' : 'entries'} under '${prefix}' (--forget-unscanned): ` +
    `${files.join(', ')}${more > 0 ? `, +${more} more` : ''}. ` +
    `${one ? 'This consent decision is' : 'These consent decisions are'} deleted — align will report the ` +
    `${one ? 'violation' : 'violations'} again as new if ${one ? 'that path is' : 'those paths are'} ever scanned.`
  );
}

/** Printed instead of the line above when the flag was passed and forfeited nothing. A prefix that
 * matched no retained entry is almost always a typo, and silence would let the user believe the
 * forfeiture happened. Not an error: `prune` still did its real work, so the exit code is the
 * prune's, not the flag's. */
export function describeForgetPrefixMatchedNothing(prefix: RepoRelativePath): string {
  return `--forget-unscanned '${prefix}' matched no retained entry — nothing was forfeited under that prefix.`;
}
