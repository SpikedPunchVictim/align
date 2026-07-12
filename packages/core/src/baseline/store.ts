import type { RepoRelativePath, RuleId, ViolationId } from '../types/branded.js';
import type { DependencyGraph } from '../types/graph.js';
import type { Violation } from '../types/violation.js';

export interface BaselineEntry {
  readonly fingerprint: ViolationId; // snippet-hash, not line-based (ADR 006)
  readonly ruleId: RuleId; // queryable — enables `baseline accept --rule` (ADR 006)
  readonly file: RepoRelativePath;
  readonly acceptedAt: number;
  readonly acceptedBy: 'init-seed' | 'accept-existing' | 'manual';
}

export interface PruneResult {
  readonly removed: readonly ViolationId[]; // no longer present in the graph — fixed
  readonly moved: readonly { readonly from: ViolationId; readonly to: ViolationId }[]; // same
  // snippet hash, different file/line
}

export interface BaselineStore {
  isBaselined(violationId: ViolationId): boolean;
  accept(violations: readonly Violation[], mode: BaselineEntry['acceptedBy']): void;
  acceptByRule(ruleId: RuleId, violations: readonly Violation[]): void;
  prune(currentGraph: DependencyGraph, currentViolations: readonly Violation[]): PruneResult;
  show(filter?: { readonly ruleId?: RuleId }): readonly BaselineEntry[];
  /** Not part of docs/core-interfaces.md's contract — the CLI's persistence boundary needs a
   * flat snapshot to serialize to `.align/baseline.json`; core stays fs-free (functional core /
   * imperative shell, CODING_BEST_PRACTICES.md §15/§16) and only exposes plain data here. */
  snapshot(): readonly BaselineEntry[];
}

/**
 * Pure, in-memory baseline store — no filesystem I/O (functional core; persistence is the CLI's
 * imperative-shell responsibility, loaded into / dumped out of this store as plain
 * `BaselineEntry[]` data). Move detection (ADR 006): `prune` compares the current violation set's
 * fingerprints against stored ones; a fingerprint appearing in the new set at a different
 * file/line than the stored entry is reported as the same logical violation.
 *
 * NOTE: because fingerprints already fold in structural identity (file/specifier/edge-set) as
 * well as the snippet, a fingerprint match IS a move-or-unchanged match by construction; "moved"
 * below is reported whenever the fingerprint is retained but the recorded `file` differs, which
 * happens only if a caller re-derives the same fingerprint for content that moved files without
 * the file path being part of the hash. v1's fingerprints intentionally include `file`/`fromFile`
 * for no-dependency/layers (so a moved violation gets a NEW fingerprint and is classified as
 * `removed` + a fresh entry rather than `moved`) — see docs deviation note in the final report.
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
      this.entries.set(v.id, { fingerprint: v.id, ruleId: v.ruleId, file: v.file, acceptedAt: now, acceptedBy: mode });
    }
  }

  acceptByRule(ruleId: RuleId, violations: readonly Violation[]): void {
    this.accept(
      violations.filter((v) => v.ruleId === ruleId),
      'manual',
    );
  }

  prune(_currentGraph: DependencyGraph, currentViolations: readonly Violation[]): PruneResult {
    const currentIds = new Set(currentViolations.map((v) => v.id));
    const removed: ViolationId[] = [];
    for (const fingerprint of this.entries.keys()) {
      if (!currentIds.has(fingerprint)) removed.push(fingerprint);
    }
    for (const id of removed) this.entries.delete(id);
    // v1's fingerprints are structural (include file/specifier), so a genuine "move" (same
    // snippet, different file) produces a different fingerprint and is observed as a plain
    // removal + a new not-yet-baselined violation, not a `moved` pair — there is no
    // content-only-hash signal in v1 to detect the move independently. `moved` stays an empty
    // array until a content-only secondary hash is added (documented deviation).
    return { removed, moved: [] };
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
