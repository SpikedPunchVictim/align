import type { RepoRelativePath, RuleId } from '../types/branded.js';
import type { ScanBlindSpot } from '../types/graph.js';
import type { UngroundedComponent } from '../components/registry.js';
import { CATEGORIES, type Violation } from '../types/violation.js';

export type GateStatus = 'green' | 'red' | 'error' | 'skipped';

// Derived from CATEGORIES (types/violation.ts), same single-source-of-truth discipline — 'parse'
// is the one gate kind that isn't a Category (it has no rule kinds of its own; a parse failure
// halts every downstream gate, ADR 008). `align skill`'s generated gate-list section reads this
// array directly (packages/cli/src/skill/gates.ts) so it cannot silently drift from GateResult's
// own shape.
export const GATE_KINDS = ['parse', ...CATEGORIES] as const;
export type GateKind = (typeof GATE_KINDS)[number];

export interface GateResult {
  readonly gate: GateKind;
  readonly status: GateStatus;
  readonly violations: readonly Violation[]; // only if 'red' — new, post-baseline
  readonly baselinedCount: number; // tolerated debt — count only, never payloads (ADR 007)
  readonly passCount?: number;
  readonly errorMessage?: string; // only if 'error' — environmental, never LLM-facing
  readonly durationMs: number;
  readonly cacheHits: number; // always 0 in v1 (ADR 005); field exists for the growth path
  readonly dependsOn: readonly (GateResult['gate'])[]; // declared metadata, not hardcoded order (ADR 008)
}

export interface Advisory {
  readonly kind: string; // e.g. 'config-conflict' | 'doc-drift' | 'divergence' | 'flaky'
  readonly message: string;
  readonly ruleIds?: readonly RuleId[];
}

export interface CheckRun {
  readonly verdict: 'green' | 'red' | 'error';
  readonly gates: readonly GateResult[];
  readonly advisories: readonly Advisory[]; // included even when verdict is green
  readonly scannedAt: number;
  /** R1 (greenfield mode, IMPLEMENTATION_PLAN.md Design Reserve "Greenfield mode"): every
   * component that is green ONLY because it matched zero files this scan (`empty: 'allow'` or
   * `'until-populated'`) — surfaced here (not just `align explain`/`doctor`) so a check-agent's own
   * loop sees "green because compliant" and "green because empty" as distinguishable states.
   * Always `[]` when the architecture gate didn't fully evaluate (parse/guard-step `error`) — there
   * is no trustworthy classification to report yet. */
  readonly ungroundedComponents: readonly UngroundedComponent[];
  /** ADR 028, generalizing task #25's `skippedNestedCheckouts`: every path THIS scan declined to
   * look at, with its reason — the same fact `graph.blindSpots` records and the advisories render
   * as prose, on the run itself as structured data. A destructive consumer (`align baseline prune`,
   * `align init`) tests "is this orphaned entry's file somewhere this scan couldn't see" directly
   * rather than parsing an advisory message (fragile — explicitly rejected by ADR 027). An entry
   * under a blind spot is unobservable this scan, not fixed, and must never be deleted alongside a
   * genuinely-fixed one.
   *
   * Same doc-comment discipline as `ungroundedComponents` above, and the same reasoning: always
   * `[]` when the architecture gate didn't fully evaluate (parse/guard-step `error`) — there is no
   * trustworthy run to report scan scope for yet. This costs nothing in practice: every destructive
   * consumer is already required to call `refuseIfRunErrored` before it would look at this field
   * (ADR 023 tier 1), so an errored run never reaches the code that would read it. */
  readonly blindSpots: readonly ScanBlindSpot[];
  /** The files this run actually observed, per scan domain (ADR 028 §5).
   *
   * This is what LET `orchestrator.knownFiles()` be deleted (ADR 028 Stage 3, done). That method
   * existed only because `CheckRun` did not carry the graph, so `align baseline prune` had to run a
   * SECOND full scan to recover the file set — two independent walks whose results were assumed to
   * agree, and nothing would have noticed when they did not.
   *
   * Carried PER DOMAIN, because `check` evaluates them per-gate: the architecture gate reasons over
   * `graph.nodes`, the security gate over `inventory.manifests`, and each runs its own
   * `reconcileMoves`. Judging one by the other's vocabulary mis-classifies — `.json` is an asset
   * extension to the source walker but a first-class file to the manifest walker, so a
   * `package.json` weighed by the source domain reads as absent.
   *
   * `baseline prune` does union them, and that is not a contradiction: `store.prune` takes a single
   * `knownFiles` and `applyMoves` iterates EVERY entry regardless of gate, so a per-domain split
   * would make each domain's entries look unobserved during the other's pass. The union it needs is
   * now written at that call site, derived from this run and costing no extra I/O — where the
   * deleted helper performed it invisibly, from a walk no rule evaluation had ever seen. Separate on
   * the run, merged explicitly by the one consumer that must.
   *
   * Empty sets when the corresponding gate didn't evaluate — same discipline as the fields above. */
  readonly observedFiles: {
    readonly source: ReadonlySet<RepoRelativePath>;
    readonly manifest: ReadonlySet<RepoRelativePath>;
  };
}
