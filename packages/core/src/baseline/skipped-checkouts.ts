import type { RepoRelativePath } from '../types/branded.js';

/**
 * `file` lives at or under `dir` — the single containment test both `InMemoryBaselineStore`'s
 * move-transfer gating (`store.ts`) and the CLI's skipped-checkout retention
 * (`packages/cli/src/nested-checkout-retention.ts`) need for the identical question: "is this
 * baseline entry's file inside a nested checkout this scan couldn't see." Lives in core (task #25
 * forged-transfer fix, F1) because `applyMoves` needs it and core must stay the sole scanning/
 * baseline-domain owner (ARCHITECTURE.md §5) — the CLI re-uses this rather than keeping its own
 * copy, so there is exactly one implementation (CLAUDE.md rule 6: hunt the class, not the instance).
 */
function isUnderDirectory(file: RepoRelativePath, dir: RepoRelativePath): boolean {
  return file === dir || file.startsWith(`${dir}/`);
}

/**
 * True when `file` lives at or under ANY of `skippedNestedCheckouts` — the "still known, even
 * though this scan didn't observe it" test `InMemoryBaselineStore.applyMoves` applies alongside
 * `knownFiles` (F1, task #25): a nested git checkout auto-excluded from the scan
 * (`CheckRun.skippedNestedCheckouts`) drops a file from `knownFiles` the exact same way a genuine
 * rename/deletion does, but for an unrelated reason — the file didn't move, the scan just couldn't
 * see it. Without this, `applyMoves` mistook that absence for FRAGILE #7's "real rename" signal and
 * went looking for a content-fingerprint match, which can silently forge the entry's
 * `acceptedAt`/`acceptedBy` onto a genuinely new, never-reviewed violation elsewhere (the exact
 * hazard `partitionSkippedCheckoutCandidates`'s retention was built to stop, but only protects the
 * `removed` arm — this closes the `moved` arm it didn't cover).
 */
export function isUnderSkippedCheckout(file: RepoRelativePath, skippedNestedCheckouts: readonly RepoRelativePath[]): boolean {
  return skippedNestedCheckouts.some((dir) => isUnderDirectory(file, dir));
}
