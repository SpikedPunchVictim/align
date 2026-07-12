import type { RepoRelativePath, RuleId, ViolationId } from '../types/branded.js';
import type { DependencyGraph } from '../types/graph.js';
import type { Violation } from '../types/violation.js';
import { computeContentFingerprint } from './fingerprint.js';

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
  prune(currentGraph: DependencyGraph, currentViolations: readonly Violation[]): PruneResult;
  /** Move-transfer only (ADR 006): for every baseline entry whose structural fingerprint is no
   * longer present in `currentViolations`, look for a current, not-yet-baselined violation with
   * the same `ruleId`+`snippet` content in a *different* file and transfer the entry to its new
   * fingerprint. Unlike `prune`, entries with no match are left in place (not removed) — intended
   * to run on every `align check` so a rename doesn't turn CI red for one cycle. Returns the
   * transferred pairs so the caller can report "N entries transferred (file moves)". */
  reconcileMoves(currentViolations: readonly Violation[]): readonly { readonly from: ViolationId; readonly to: ViolationId }[];
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
      });
    }
  }

  acceptByRule(ruleId: RuleId, violations: readonly Violation[]): void {
    this.accept(
      violations.filter((v) => v.ruleId === ruleId),
      'manual',
    );
  }

  reconcileMoves(currentViolations: readonly Violation[]): readonly { readonly from: ViolationId; readonly to: ViolationId }[] {
    return this.applyMoves(currentViolations).moved;
  }

  prune(_currentGraph: DependencyGraph, currentViolations: readonly Violation[]): PruneResult {
    const { moved, unmatchedOrphans } = this.applyMoves(currentViolations);
    for (const fingerprint of unmatchedOrphans) this.entries.delete(fingerprint);
    return { removed: unmatchedOrphans, moved };
  }

  /**
   * Shared move-transfer core for `reconcileMoves` and `prune` — the only difference between the
   * two callers is what happens to an orphaned entry that finds no match (left alone for
   * `reconcileMoves`, deleted for `prune`), so that decision is made by the caller, not here.
   */
  private applyMoves(currentViolations: readonly Violation[]): MoveResult {
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
