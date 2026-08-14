import type { RepoRelativePath, RuleId, ViolationId } from '../types/branded.js';
import type { Violation } from '../types/violation.js';
import { computeContentFingerprint } from './fingerprint.js';
import { isUnderSkippedCheckout } from './skipped-checkouts.js';

export interface BaselineEntry {
  readonly fingerprint: ViolationId; // snippet-hash, not line-based (ADR 006)
  readonly ruleId: RuleId; // queryable — enables `baseline accept --rule` (ADR 006)
  readonly file: RepoRelativePath;
  readonly acceptedAt: number;
  readonly acceptedBy: 'init-seed' | 'accept-existing' | 'manual';
  // File-independent ruleId+snippet hash (ADR 006 move-transfer). Optional so `.align/baseline.json`
  // files written before this field existed still parse — entries missing it simply can't
  // participate in move-transfer matching and fall back to prior (removed, not moved) behavior.
  readonly contentFingerprint?: ViolationId;
  // The measured value at acceptance time (e.g. `arch.metric`'s line count). Optional, same
  // back-compat discipline as `contentFingerprint` above: `.align/baseline.json` files written
  // before this field existed still parse, and entries missing it simply don't participate in
  // baseline-growth advisory detection (FRAGILE #8, bug hunt 2026-08-03 — `arch.metric`'s
  // fingerprint is deliberately file-only, so a baselined over-length file can grow without bound
  // with no fingerprint change; this field lets `gates/advisories.ts`'s growth advisory notice).
  // Only populated for violation kinds that carry a meaningful measured value (currently just
  // `metric`, from `Violation`'s `value` field) — never invented for kinds that have none.
  readonly acceptedValue?: number;
}

export interface PruneResult {
  readonly removed: readonly ViolationId[]; // no longer present in the graph — fixed
  readonly moved: readonly { readonly from: ViolationId; readonly to: ViolationId }[]; // same
  // content fingerprint (ruleId+snippet), different file — the entry transferred, not was re-accepted
}

export interface BaselineStore {
  isBaselined(violationId: ViolationId): boolean;
  accept(violations: readonly Violation[], mode: BaselineEntry['acceptedBy']): void;
  acceptByRule(ruleId: RuleId, violations: readonly Violation[]): void;
  /** `knownFiles` is the current scan's file set (domain-agnostic — the architecture gate passes
   * its graph's node files, the security gate its manifest inventory's files, ADR 013). It gates
   * move-transfer the same way `reconcileMoves` below does — see that doc comment for why. Callers
   * MUST derive it from the scan's own file list, never from `currentViolations` (a fixed file has
   * no violations, so deriving from violations would make every fixed file look deleted).
   *
   * `skippedNestedCheckouts` (task #25 forged-transfer fix, F1): repo-relative paths a scan
   * auto-excluded because they carry their own `.git`. An entry whose file lives under one of these
   * is treated as "still known" the same as if it were literally in `knownFiles` — see
   * `reconcileMoves`'s doc comment below for why. REQUIRED on this interface (review 2026-08-13): it
   * was optional, and one of the two production call sites that could omit it did — `runSecurityGate`
   * (`orchestrator.ts`) called `reconcileMoves` with two arguments, silently reinstating the pre-fix
   * behaviour with no type error. A caller with genuinely nothing to pass now states that by passing
   * `[]`, which is a visible, reviewable decision rather than an invisible default. */
  prune(
    currentViolations: readonly Violation[],
    knownFiles: ReadonlySet<RepoRelativePath>,
    skippedNestedCheckouts: readonly RepoRelativePath[],
  ): PruneResult;
  /** Move-transfer only (ADR 006): for every baseline entry whose structural fingerprint is no
   * longer present in `currentViolations` AND whose recorded `file` is no longer in `knownFiles`
   * (a real rename/deletion — FRAGILE #7, bug hunt 2026-08-03), look for a current, not-yet-
   * baselined violation with the same `ruleId`+`snippet` content in a *different* file and transfer
   * the entry to its new fingerprint. An orphan whose own file is STILL in `knownFiles` was fixed,
   * not moved — an identical-looking violation elsewhere is a genuinely new violation and is never
   * matched, even if the content fingerprint collides. Unlike `prune`, entries with no match are
   * left in place (not removed) — intended to run on every `align check` so a rename doesn't turn
   * CI red for one cycle. Returns the transferred pairs so the caller can report "N entries
   * transferred (file moves)".
   *
   * `knownFiles` is the current scan's file set, domain-agnostic (never a `DependencyGraph` — the
   * `security` gate has no graph, only a `ManifestInventory`, ADR 013). Callers MUST derive it from
   * the scan's own file list, never from `currentViolations` (see `prune`'s doc comment above).
   *
   * `skippedNestedCheckouts` (task #25 forged-transfer fix, F1, bug hunt/review 2026-08-12):
   * task #25's nested-checkout auto-exclusion drops a file from `knownFiles` the same way a real
   * rename does, but for an unrelated reason — the file didn't move, the scan simply couldn't see
   * it. Without this, that absence alone satisfied FRAGILE #7's "orphan's own file is gone" test, so
   * a checkout-resident entry whose `contentFingerprint` happened to collide with a live,
   * never-accepted violation elsewhere (the expected case for a vendored copy of the same code) was
   * silently classified as "moved" — forging the entry's `acceptedAt`/`acceptedBy` onto a violation
   * nobody ever reviewed. Treating a file under one of these paths as "still known" routes it to
   * `unmatchedOrphans` instead (the exact arm `prune`'s skipped-checkout retention already
   * protects), never to a content-fingerprint search. REQUIRED — see `prune`'s note above for why
   * the optional version was itself the defect-propagation hazard. */
  reconcileMoves(
    currentViolations: readonly Violation[],
    knownFiles: ReadonlySet<RepoRelativePath>,
    skippedNestedCheckouts: readonly RepoRelativePath[],
  ): readonly { readonly from: ViolationId; readonly to: ViolationId }[];
  show(filter?: { readonly ruleId?: RuleId }): readonly BaselineEntry[];
  /** Not part of docs/core-interfaces.md's contract — the CLI's persistence boundary needs a
   * flat snapshot to serialize to `.align/baseline.json`; core stays fs-free (functional core /
   * imperative shell, CODING_BEST_PRACTICES.md §15/§16) and only exposes plain data here. */
  snapshot(): readonly BaselineEntry[];
}

interface MoveResult {
  readonly moved: { readonly from: ViolationId; readonly to: ViolationId }[];
  readonly unmatchedOrphans: readonly ViolationId[];
}

/**
 * Pure, in-memory baseline store — no filesystem I/O (functional core; persistence is the CLI's
 * imperative-shell responsibility, loaded into / dumped out of this store as plain
 * `BaselineEntry[]` data).
 *
 * Move detection (ADR 006): a violation's structural `fingerprint` folds in file identity (e.g.
 * `fromFile`/`toFile` for no-dependency), so a rename produces a brand-new fingerprint and orphans
 * the old baseline entry by construction — that's the exact "renaming a file orphans its baseline
 * entries" gap ADR 006's move-transfer design targets. `contentFingerprint` (ruleId+snippet,
 * file-independent) is the secondary signal that recovers the match: `applyMoves` looks for a
 * current, not-already-baselined violation carrying the same content fingerprint in a *different*
 * file than the orphaned entry's recorded file, and transfers the entry onto the new structural
 * fingerprint instead of treating the rename as "fixed" + "new". A violation whose *original*
 * fingerprint is still present is never touched by this — so a genuinely new violation with an
 * identical snippet in a second location, while the original violation/file still exists, is never
 * mistaken for a move (both fingerprints remain distinct baseline-relevant entries).
 *
 * FRAGILE #7 fix (bug hunt 2026-08-03): the case the paragraph above does NOT cover is a fixed
 * violation coexisting, in the same scan, with a textually identical NEW violation in a different
 * file — e.g. `import { db } from './db'` removed from `a.ts` and added to `b.ts` in one commit.
 * Content fingerprints collide and `a.ts`'s file differs from `b.ts`'s, so the pre-fix matcher
 * transferred the baseline entry onto `b.ts`, silently pre-accepting a genuinely new violation.
 * `applyMoves` now additionally requires the orphan's own recorded `file` to be ABSENT from
 * `knownFiles` (the current scan's file set) before it will even look for a content match — "moved"
 * means the old file is gone (a real rename), not merely "some other file has matching text". This
 * does not regress the rename case: a rename removes the old path from the scan by construction, so
 * the entry stays eligible and still transfers.
 */
export class InMemoryBaselineStore implements BaselineStore {
  private readonly entries = new Map<ViolationId, BaselineEntry>();

  constructor(initial: readonly BaselineEntry[] = []) {
    for (const entry of initial) this.entries.set(entry.fingerprint, entry);
  }

  isBaselined(violationId: ViolationId): boolean {
    return this.entries.has(violationId);
  }

  accept(violations: readonly Violation[], mode: BaselineEntry['acceptedBy']): void {
    const now = Date.now();
    for (const v of violations) {
      this.entries.set(v.id, {
        fingerprint: v.id,
        ruleId: v.ruleId,
        file: v.file,
        acceptedAt: now,
        acceptedBy: mode,
        contentFingerprint: computeContentFingerprint(v.ruleId, v.snippet),
        // Only `metric`-kind violations carry a meaningful measured value — never invent one for
        // kinds that have none (FRAGILE #8's growth advisory relies on absence here to skip
        // cleanly, same discipline as `contentFingerprint`'s optionality above).
        ...(v.kind === 'metric' ? { acceptedValue: v.value } : {}),
      });
    }
  }

  acceptByRule(ruleId: RuleId, violations: readonly Violation[]): void {
    this.accept(
      violations.filter((v) => v.ruleId === ruleId),
      'manual',
    );
  }

  // `= []` on the CLASS implementations of `reconcileMoves`/`prune`/`applyMoves` below, while the
  // INTERFACE declares the parameter required (see its doc comments): a default satisfies a required
  // interface parameter, which keeps the two-argument calls in `core/test/baseline.test.ts` (which
  // construct this class directly) compiling. The residual this deliberately leaves: a caller
  // holding the concrete class rather than `BaselineStore` can still omit it. Verified 2026-08-13 —
  // no production code does; the only two `.prune(...)` call sites (`commands/baseline.ts`,
  // `commands/upgrade.ts`) are class-typed and both pass the paths explicitly.
  reconcileMoves(
    currentViolations: readonly Violation[],
    knownFiles: ReadonlySet<RepoRelativePath>,
    skippedNestedCheckouts: readonly RepoRelativePath[] = [],
  ): readonly { readonly from: ViolationId; readonly to: ViolationId }[] {
    return this.applyMoves(currentViolations, knownFiles, skippedNestedCheckouts).moved;
  }

  prune(
    currentViolations: readonly Violation[],
    knownFiles: ReadonlySet<RepoRelativePath>,
    skippedNestedCheckouts: readonly RepoRelativePath[] = [],
  ): PruneResult {
    const { moved, unmatchedOrphans } = this.applyMoves(currentViolations, knownFiles, skippedNestedCheckouts);
    for (const fingerprint of unmatchedOrphans) this.entries.delete(fingerprint);
    return { removed: unmatchedOrphans, moved };
  }

  /**
   * Shared move-transfer core for `reconcileMoves` and `prune` — the only difference between the
   * two callers is what happens to an orphaned entry that finds no match (left alone for
   * `reconcileMoves`, deleted for `prune`), so that decision is made by the caller, not here.
   */
  private applyMoves(
    currentViolations: readonly Violation[],
    knownFiles: ReadonlySet<RepoRelativePath>,
    skippedNestedCheckouts: readonly RepoRelativePath[] = [],
  ): MoveResult {
    const currentIds = new Set(currentViolations.map((v) => v.id));
    const orphaned = [...this.entries.values()].filter((e) => !currentIds.has(e.fingerprint));
    if (orphaned.length === 0) return { moved: [], unmatchedOrphans: [] };

    // Candidate move targets: current violations not already tracked under their own fingerprint
    // (a violation that's already directly baselined isn't a move — it's unchanged).
    const candidatesByContent = new Map<ViolationId, Violation[]>();
    for (const v of currentViolations) {
      if (this.entries.has(v.id)) continue;
      const content = computeContentFingerprint(v.ruleId, v.snippet);
      const list = candidatesByContent.get(content);
      if (list === undefined) candidatesByContent.set(content, [v]);
      else list.push(v);
    }

    const moved: { from: ViolationId; to: ViolationId }[] = [];
    const unmatchedOrphans: ViolationId[] = [];

    for (const entry of orphaned) {
      // FRAGILE #7 (bug hunt 2026-08-03): "moved" means the orphan's OWN file is gone from this
      // scan — a real rename/deletion. If it's still known, the violation there was fixed, so an
      // identical-looking violation elsewhere is a genuinely new violation, not a move, even if the
      // content fingerprint collides. This check runs before any content-match lookup.
      //
      // F1 (task #25 forged-transfer fix, review 2026-08-12): a file under `skippedNestedCheckouts`
      // is ALSO treated as "still known" here, even though it's absent from `knownFiles` — the scan
      // didn't observe it because it auto-excluded the checkout, not because the file moved. Without
      // this, an entry like a vendored submodule's copy of some code — same ruleId, identical
      // trimmed import line as a live, never-accepted violation elsewhere, the expected case for a
      // vendored copy — got misclassified as "moved," forging its acceptedAt/acceptedBy onto a
      // violation nobody reviewed. Folding it into this same branch routes it to `unmatchedOrphans`,
      // the exact arm `baseline prune`'s skipped-checkout retention (`nested-checkout-retention.ts`)
      // already protects from deletion — so this fix composes with that retention instead of needing
      // a second mechanism.
      if (knownFiles.has(entry.file) || isUnderSkippedCheckout(entry.file, skippedNestedCheckouts)) {
        unmatchedOrphans.push(entry.fingerprint);
        continue;
      }

      const content = entry.contentFingerprint;
      const candidates = content === undefined ? undefined : candidatesByContent.get(content);
      const matchIdx = candidates?.findIndex((v) => v.file !== entry.file) ?? -1;
      const matched = matchIdx === -1 || candidates === undefined ? undefined : candidates[matchIdx];

      if (matched === undefined) {
        unmatchedOrphans.push(entry.fingerprint);
        continue;
      }

      candidates?.splice(matchIdx, 1); // consumed — don't let a second orphan claim the same target
      this.entries.delete(entry.fingerprint);
      this.entries.set(matched.id, {
        fingerprint: matched.id,
        ruleId: entry.ruleId,
        file: matched.file,
        acceptedAt: entry.acceptedAt,
        acceptedBy: entry.acceptedBy,
        ...(entry.contentFingerprint === undefined ? {} : { contentFingerprint: entry.contentFingerprint }),
        // A moved entry is still the same accepted debt, now under a new file — carry the
        // recorded value forward the same way contentFingerprint is carried forward above.
        ...(entry.acceptedValue === undefined ? {} : { acceptedValue: entry.acceptedValue }),
      });
      moved.push({ from: entry.fingerprint, to: matched.id });
    }

    return { moved, unmatchedOrphans };
  }

  show(filter?: { readonly ruleId?: RuleId }): readonly BaselineEntry[] {
    const all = [...this.entries.values()];
    if (filter?.ruleId === undefined) return all;
    return all.filter((e) => e.ruleId === filter.ruleId);
  }

  snapshot(): readonly BaselineEntry[] {
    return [...this.entries.values()];
  }
}
