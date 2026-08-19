import type { BaselineDebt, BaselineEntry, CheckRun, FileExistenceProbe, RepoRelativePath } from '@spikedpunch/align-core';
import { partitionBlindSpotCandidates } from './scan-blind-spot-retention.js';

/**
 * Extracted from `commands/check.ts` on 2026-08-18, when ADR 029's writer pushed that file past the
 * 500-line `arch.metric:loc:cli` limit align enforces on itself. A mechanical move: this is the one
 * function three surfaces share, it depends on nothing else in `check.ts`, and giving it its own
 * module makes the "one guarded computation, never a re-inlined copy" property visible in the file
 * layout rather than only in the comment below.
 */

/** The one baseline-debt computation shared by `align check`, MCP `align_check`, and the payload
 * builder's fallback — a single guarded function so the error-run correction (below) can't drift
 * across copies (it did: three inline `Σ baselinedCount` sites, and only two were first fixed).
 *
 * `builder.ts`'s `fallbackBaselineDebt` is deliberately NOT a fourth instance of either defect and
 * needs no change: it has no previous baseline to compare against, sets `previous = current`, and
 * therefore can never report a drop at all. Checked 2026-08-18 while fixing D016, and recorded so
 * the next reader auditing this class does not have to check it twice.
 * The same asymmetry has a MUTATING half — commands that delete/overwrite baseline entries from a
 * run's violations (`baseline prune`, `init`) — guarded by `refuseIfRunErrored` (`errored-run.ts`),
 * which is where a new consumer of flattened gate violations should look first. */
export function computeBaselineDebt(
  previousBaseline: readonly BaselineEntry[],
  run: CheckRun,
  fileExists: FileExistenceProbe,
): BaselineDebt {
  // DISTINCT BY FINGERPRINT, because that is what every other consumer counts.
  // `InMemoryBaselineStore` keys its entries by fingerprint, so two rows sharing one are a single
  // entry to the store, to `prune`, and to the matcher — but `previous` counted ROWS. A
  // hand-edited or merge-mangled `baseline.json` (the schema permits duplicates and `writeBaseline`
  // does not dedupe) therefore reported a permanent `-1` on every run, for a repository where
  // nothing was fixed. D016's symptom from a third cause, found by adversarial review.
  const distinct = [...new Map(previousBaseline.map((entry) => [entry.fingerprint, entry])).values()];
  const previous = distinct.length;
  // TIER 1 — an errored gate reports `baselinedCount: 0` (orchestrator.ts) though its on-disk
  // baseline entries still exist, so summing on an error run fabricates a debt DROP (`47 → 0
  // (−47)`) exactly when nothing was verified — a false "debt eliminated" ratchet signal in human +
  // JSON + MCP output. The ratchet only moves on a fully-evaluated scan (any errored gate ⇒
  // `verdict:'error'`, deriveVerdict); otherwise report no change (current = previous, delta 0).
  //
  // Ordered before tier 2 deliberately: an errored run evaluated no rule anywhere, so there is no
  // sound per-entry statement to make about it, and the coarser answer is the only honest one.
  if (run.verdict === 'error') return { previous, current: previous, delta: 0 };

  // TIER 2 (LEDGER D016) — the SECOND cause of the identical fabrication, introduced by ADR 028 and
  // missed when tier 1 was written. Shape S-09, *fixed one arm, missed the other*: an entry whose
  // file this scan could not observe produces no current violation, so it contributes 0 to the sum
  // below in exactly the way a genuinely fixed one does. Measured against the built binary before
  // this fix — two accepted entries behind one `excludes` pattern reported `baselined debt: 2 → 0
  // (-2)`, verdict green, exit 0, with both entries still on disk and nothing fixed, while `prune`
  // on the same state correctly reported `Retained 2 entries`.
  //
  // COUNTED AS STILL-BASELINED rather than suppressing the line, and that is the whole design.
  // Suppression (report no change whenever anything is unobservable) is the obvious move and it is
  // shape S-04, *a guard correct in the unsafe direction and wrong in the safe one*: with 500
  // entries, 2 hidden and 10 genuinely fixed, it would hide a real 10-entry paydown to avoid a
  // 2-entry error. An unobservable entry is not paid-off debt; it is debt align could not look at,
  // which is precisely what `prune` already does with the same entries through the same partition.
  // Reusing `partitionBlindSpotCandidates` is what keeps this reporting path and that destructive
  // path from disagreeing again — the disagreement WAS the defect.
  //
  const observed: ReadonlySet<RepoRelativePath> = new Set([...run.observedFiles.source, ...run.observedFiles.manifest]);
  const unobserved = distinct.filter((entry) => !observed.has(entry.file));
  const unobservable = partitionBlindSpotCandidates(unobserved, run.blindSpots, observed, fileExists).retained.length;

  const matched = run.gates.reduce((sum, g) => sum + g.baselinedCount, 0);
  // CLAMPED, and the clamp is a correctness guard rather than defensive noise. An earlier comment
  // here claimed the `!observed.has(...)` pre-filter made double counting impossible. That was
  // false, and adversarial review reproduced it: `matched` counts violations under their
  // POST-transfer paths while the retention partition counts baseline entries under their
  // PRE-transfer paths, so a move-transferred entry sits in both coordinate systems and the filter
  // excludes nothing. Measured: `{previous:1, current:2, delta:+1}` — align reporting that debt
  // GREW on a run where one file was renamed.
  //
  // `store.applyMoves` refuses to transfer anything the partition would retain, which is why no
  // repository state reaches it today. But that lives in another package, is asserted nowhere, and
  // the two predicate sets read DIFFERENT inputs — `applyMoves` gets one domain's blind spots, this
  // gets the union of both — so it is incidental safety, not a guarantee. `current` counting live
  // debt cannot exceed the number of entries that debt is recorded in; treating a violation of that
  // as an impossibility rather than printing it is the honest reading.
  const current = Math.min(matched + unobservable, previous);
  return { previous, current, delta: current - previous };
}
