import type { SelectRangeFrom } from './migrations/index.js';
import type { VersionFile } from './version-file.js';

/**
 * **`baselineReconciledBy`, NOT `alignVersion`** (LEDGER D028, fixed 2026-08-19). This line read
 * `stamp?.alignVersion` and was the field's only would-be consumer reading the wrong one — while
 * `baselineReconciledBy` itself had ZERO readers anywhere in the codebase.
 *
 * The two answer different questions, and `version-file.ts` says so in the field's own doc comment:
 * `alignVersion` is "who last wrote anything under `.align/`", stamped by every committed-artifact
 * writer (`baseline accept`, `baseline prune`, `build --apply`, `export-ir`, and any `check` that
 * move-transfers); `baselineReconciledBy` is "the version under which the baseline was last
 * DELIBERATELY reconciled", written only by `init` and by this command's final step. That comment
 * also records that an earlier ADR draft specified last-writer-of-`baseline.json` and **was wrong**,
 * because incidental writers "would make a 'last writer' field read as current after routine CI,
 * defeating the field's purpose". The project identified the hazard, built a field to avoid it, and
 * then gated on the field it had just rejected.
 *
 * Measured before the fix: run any stamping command once under the new binary — `align export-ir`
 * is enough, and it does not touch `baseline.json` at all — and every later `align upgrade` prints
 * "Already at the current version — nothing to reconcile" and exits 0, permanently. Worse, `upgrade`
 * disarms ITSELF: a run blocked by ADR 023 tier 2 still performs the accept half, which stamps, so
 * the very run that prints "Re-run `align upgrade` to finish" is the run that makes the re-run a
 * no-op.
 *
 * **The fallback is `'unknown'`, never `alignVersion`.** Substituting it is the defect, not a
 * degraded version of the fix: it asserts a reconciliation that may never have happened. An absent
 * watermark means exactly that — align does not know — and 'unknown' is what this command already
 * has for that state. `init` writes the field unconditionally on every run, so the only repositories
 * without one are those whose `.align/version.json` was created by a bare stamp, or by an align
 * predating ADR 022; offering to reconcile those is the conservative direction.
 */
export function reconciliationWatermark(stamp: VersionFile | undefined, fromOverride: string | undefined): SelectRangeFrom {
  return fromOverride ?? stamp?.baselineReconciledBy ?? 'unknown';
}

/** How the transition reads to a human. Says WHICH question the left-hand version answers, because
 * "0.1.4 → 0.2.0" alone invites the reading that bit this command: that it is about the binary. */
export function describeUpgradeTransition(from: SelectRangeFrom, to: string): string {
  return `align upgrade: ${from} → ${to} (baseline last reconciled under ${from === 'unknown' ? 'an unrecorded version' : from})`;
}
