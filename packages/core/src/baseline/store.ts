import type { RepoRelativePath, RuleId, ViolationId } from '../types/branded.js';
import type { FileExistenceProbe } from '../types/file-existence.js';
import type { ScanBlindSpot } from '../types/graph.js';
import type { Violation } from '../types/violation.js';
import { computeContentFingerprint } from './fingerprint.js';
import { isUnderAbsentDirectory, isUnderBlindSpot } from './scan-blind-spots.js';

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
  // Same content fingerprint (ruleId+snippet), different file — the entry transferred rather than
  // being re-accepted. Carries the full `MovedEntry` so `prune` can REPORT each transfer rather than
  // only counting it; see `describeMovedEntries` for why a count is unreviewable (LEDGER D015).
  readonly moved: readonly MovedEntry[];
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
   * `blindSpots` (ADR 028, generalizing ADR 027's F1 forged-transfer fix): every path THIS scan
   * declined to look at, with its reason — an auto-excluded nested checkout, an `excludes` match, a
   * `node_modules`-class directory name, an unreadable directory, a symlink. An entry whose file
   * lives at or under one of these is treated as "still known" the same as if it were literally in
   * `knownFiles` — see `reconcileMoves`'s doc comment below for why. REQUIRED on this interface
   * (review 2026-08-13): it was optional, and one of the two production call sites that could omit
   * it did — `runSecurityGate` (`orchestrator.ts`) called `reconcileMoves` with two arguments,
   * silently reinstating the pre-fix behaviour with no type error. A caller with genuinely nothing
   * to pass now states that by passing `[]`, which is a visible, reviewable decision rather than an
   * invisible default. */
  prune(
    currentViolations: readonly Violation[],
    knownFiles: ReadonlySet<RepoRelativePath>,
    blindSpots: readonly ScanBlindSpot[],
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
   * `blindSpots` (ADR 028, generalizing ADR 027's F1 fix): a path the walk declined to look at
   * drops its files from `knownFiles` the same way a real rename does, but for an unrelated reason —
   * the file didn't move, the scan simply couldn't see it. Without this, that absence alone
   * satisfies FRAGILE #7's "orphan's own file is gone" test, so an unobserved entry whose
   * `contentFingerprint` happens to collide with a live, never-accepted violation elsewhere (the
   * expected case for a vendored copy of the same code, or for a file re-added under a different
   * path) is silently classified as "moved" — forging the entry's `acceptedAt`/`acceptedBy` onto a
   * violation nobody ever reviewed and turning `align check` green. THIS IS THE ARM THAT RUNS ON
   * EVERY `align check`: no destructive command, no flag, no completeness gate stands in front of
   * it. Treating a file under a blind spot as "still known" routes it to `unmatchedOrphans` instead
   * (the exact arm `prune`'s retention already protects), never to a content-fingerprint search.
   * REQUIRED — see `prune`'s note above for why the optional version was itself the
   * defect-propagation hazard. */
  reconcileMoves(
    currentViolations: readonly Violation[],
    knownFiles: ReadonlySet<RepoRelativePath>,
    blindSpots: readonly ScanBlindSpot[],
  ): readonly MovedEntry[];
  show(filter?: { readonly ruleId?: RuleId }): readonly BaselineEntry[];
  /** Not part of docs/core-interfaces.md's contract — the CLI's persistence boundary needs a
   * flat snapshot to serialize to `.align/baseline.json`; core stays fs-free (functional core /
   * imperative shell, CODING_BEST_PRACTICES.md §15/§16) and only exposes plain data here. */
  snapshot(): readonly BaselineEntry[];
}

/** What a transfer carries, for the report that makes it reviewable (LEDGER D015, 2026-08-18).
 * Fingerprints alone were enough to COUNT transfers; they are not enough to review one. A transfer
 * moves a human's recorded acceptance onto a different file, and align cannot prove the violation
 * moved rather than the old file being deleted while an identical one already existed — so the two
 * paths and the consent being carried are the minimum a reader needs to spot a forgery. */
export interface MovedEntry {
  readonly from: ViolationId;
  readonly to: ViolationId;
  readonly fromFile: RepoRelativePath;
  readonly toFile: RepoRelativePath;
  readonly ruleId: RuleId;
  readonly acceptedAt: number;
  readonly acceptedBy: BaselineEntry['acceptedBy'];
}

interface MoveResult {
  readonly moved: MovedEntry[];
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

  constructor(
    initial: readonly BaselineEntry[] = [],
    /**
     * ADR 028 mechanism 2 — REQUIRED, with no default, and that is the whole point. A default of
     * `() => false` would compile everywhere and silently restore pre-ADR-028 behaviour at any site
     * that forgot to pass one, which is precisely the counter-example ADR 027 records against
     * optional safety parameters and precisely what happened to `reconcileMoves`'
     * `skippedNestedCheckouts` (review 2026-08-13: it was optional, and a production call site
     * omitted it). A default of `() => true` is no better — it would make `prune` a permanent no-op.
     * There is no safe default, so there is no default: every construction site states its answer.
     *
     * Core never constructs this (no `node:fs` under `core/src`, ever): the CLI injects the one real
     * `fs`-backed probe from `cli/src/file-existence.ts`, and tests inject a fake.
     */
    private readonly fileExists: FileExistenceProbe,
  ) {
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
  // holding the concrete class rather than `BaselineStore` can still omit it. Verified 2026-08-16 —
  // no production code does; the only two `.prune(...)` call sites (`commands/baseline.ts`,
  // `commands/upgrade.ts`) are class-typed and both pass the blind spots explicitly.
  reconcileMoves(
    currentViolations: readonly Violation[],
    knownFiles: ReadonlySet<RepoRelativePath>,
    blindSpots: readonly ScanBlindSpot[] = [],
  ): readonly MovedEntry[] {
    return this.applyMoves(currentViolations, knownFiles, blindSpots).moved;
  }

  prune(
    currentViolations: readonly Violation[],
    knownFiles: ReadonlySet<RepoRelativePath>,
    blindSpots: readonly ScanBlindSpot[] = [],
  ): PruneResult {
    const { moved, unmatchedOrphans } = this.applyMoves(currentViolations, knownFiles, blindSpots);
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
    blindSpots: readonly ScanBlindSpot[] = [],
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

    const moved: MovedEntry[] = [];
    const unmatchedOrphans: ViolationId[] = [];

    for (const entry of orphaned) {
      // FRAGILE #7 (bug hunt 2026-08-03): "moved" means the orphan's OWN file is gone from this
      // scan — a real rename/deletion. If it's still known, the violation there was fixed, so an
      // identical-looking violation elsewhere is a genuinely new violation, not a move, even if the
      // content fingerprint collides. This check runs before any content-match lookup.
      //
      // ADR 028 (generalizing ADR 027's F1 fix, review 2026-08-12): a file under ANY recorded blind
      // spot is ALSO treated as "still known" here, even though it's absent from `knownFiles` — the
      // scan didn't observe it because it declined to look there (auto-excluded checkout, `excludes`
      // match, `node_modules`-class name, unreadable directory, symlink), not because the file
      // moved. Without this, an entry whose trimmed line matches a live, never-accepted violation
      // elsewhere — the expected case for a vendored copy of the same code — gets misclassified as
      // "moved," forging its acceptedAt/acceptedBy onto a violation nobody reviewed. ADR 027 closed
      // this for the checkout reason only; ADR 028 measured five more, two of them reproduced
      // against the built binary. Folding them into this same branch routes the entry to
      // `unmatchedOrphans`, the exact arm `baseline prune`'s retention
      // (`cli/src/scan-blind-spot-retention.ts`) already protects from deletion — so this composes
      // with that retention instead of needing a second mechanism.
      //
      // ADR 028 mechanism 2, the third disjunct: the file is STILL ON DISK even though this scan
      // produced no node for it and recorded no blind spot covering it. That combination means the
      // scan was narrower than the repository for a reason nobody has enumerated — which is the
      // normal case, historically, since ADR 027's enumeration missed five. Whatever the cause, a
      // file that exists was not renamed, so offering it for a content-fingerprint match could only
      // forge consent. `fileExists` is evaluated LAST of the three because it is the only one that
      // touches a filesystem; the two in-memory tests short-circuit it for every ordinary orphan.
      // ADR 028 mechanism 3, the fourth disjunct (added 2026-08-17, LEDGER D010): the file is gone
      // AND so is its directory. Mechanisms 1-2 both answer "nothing explains this" for a missing
      // tree, so without this an orphan from a partial checkout was offered for a content match and
      // transferred — forging consent onto a never-reviewed violation, from a plain `align check`,
      // at exit 0. Same predicate as the CLI's retention partition, imported rather than restated.
      if (
        knownFiles.has(entry.file) ||
        isUnderBlindSpot(entry.file, blindSpots) ||
        this.fileExists(entry.file) ||
        isUnderAbsentDirectory(entry.file, knownFiles, this.fileExists)
      ) {
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
      moved.push({
        from: entry.fingerprint,
        to: matched.id,
        fromFile: entry.file,
        toFile: matched.file,
        ruleId: entry.ruleId,
        acceptedAt: entry.acceptedAt,
        acceptedBy: entry.acceptedBy,
      });
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
