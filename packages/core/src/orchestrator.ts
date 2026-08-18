import type { RepoRelativePath } from './types/branded.js';
import type { DependencyGraph, ScanBlindSpot } from './types/graph.js';
import type { RulesetIR } from './types/ir.js';
import type { Violation } from './types/violation.js';
import { EMPTY_MANIFEST_INVENTORY, type ManifestScanner } from './types/manifest.js';
import type { BaselineStore, MovedEntry } from './baseline/store.js';
import { describeMovedEntries } from './baseline/scan-blind-spots.js';
import type { Advisory, CheckRun, GateResult } from './gates/types.js';
import {
  buildBaselineGrowthAdvisories,
  buildScanBlindSpotAdvisories,
  buildUncertaintyAdvisories,
  buildUngroundedExternalSelectorAdvisories,
} from './gates/advisories.js';
import type { PluginRegistry } from './plugin/registry.js';
import { evaluateRule } from './rules/evaluators.js';
import { evaluateManifestRule, type SecurityManifestRule } from './rules/manifest-evaluators.js';
import { ruleCategoryOf } from './rules/rule-category.js';
import { validateRuleComponentRefs } from './rules/component-refs.js';
import { validateHostRules, type HostPredicateRegistry } from './rules/host-rules.js';
import { findUngroundedComponents, validateClassifiedComponents, validateSelectorSyntax } from './components/registry.js';

/** No predicates registered — the default for callers that don't inject one (most existing tests
 * exercise portable `arch.*` kinds only; a real deployment always gets a real registry from the
 * CLI composition root, `packages/cli/src/composition-root.ts`). */
const NO_HOST_PREDICATES: HostPredicateRegistry = new Map();

/** No-op default for callers that don't inject a real manifest scanner (most existing tests never
 * author `security.manifest.*` rules; a real deployment gets `@spikedpunch/align-plugin-typescript`'s
 * `NodeManifestScanner` from the CLI composition root — core never imports plugin-typescript
 * directly, ADR 013/ARCHITECTURE.md §5). Returns the empty inventory, never throws — a repo with
 * no `security.manifest.*` rules authored never even calls this. */
const NO_MANIFEST_SCANNER: ManifestScanner = { scan: () => EMPTY_MANIFEST_INVENTORY };

export interface CheckOptions {
  readonly rootDir: string; // absolute filesystem path
  readonly excludes: readonly string[];
  // Task #25: opt-out paths for a nested git checkout the walk would otherwise auto-exclude —
  // threaded straight through to `ScanInput.includeNestedCheckouts`. Optional so every pre-existing
  // caller (tests, anything predating this option) keeps working unchanged.
  readonly includeNestedCheckouts?: readonly string[];
}

/**
 * Ties scanning, rule evaluation, and baseline filtering into one `CheckRun` (ARCHITECTURE.md
 * §3). Rescan-on-check, always (ADR 005) — there is no cached-result path to call by mistake.
 */
export class GateOrchestrator {
  constructor(
    private readonly registry: PluginRegistry,
    private readonly ruleset: RulesetIR,
    private readonly baselineStore: BaselineStore,
    /** Injected, never constructed here (core stays framework-free) — the CLI composition root
     * extracts this from `align.config.ts`'s `hostRules` export (`config.ts`, `composition-root.ts`).
     * Defaults to empty so every pre-existing caller (tests, anything not using `custom.host`)
     * keeps working unchanged. */
    private readonly hostPredicates: HostPredicateRegistry = NO_HOST_PREDICATES,
    /** Injected, never constructed here (ADR 013, same seam as `hostPredicates` above) — the CLI
     * composition root wires in `@spikedpunch/align-plugin-typescript`'s `NodeManifestScanner`. Defaults to a
     * no-op so every pre-existing caller (tests, anything not authoring `security.manifest.*`
     * rules) keeps working unchanged. */
    private readonly manifestScanner: ManifestScanner = NO_MANIFEST_SCANNER,
  ) {}

  async check(options: CheckOptions): Promise<CheckRun> {
    const scannedAt = Date.now();

    // `security` gate (ADR 013): manifest-level, independent of the TypeScript source scan
    // entirely — a disjoint scan domain (`ManifestInventory`, not `DependencyGraph`). Computed
    // first, unconditionally, so a TS scan failure below never blocks it (ADR 008's always-run
    // carve-out: `dependsOn: []`, "must always run regardless of what upstream gates report").
    const {
      gateResult: securityGate,
      moved: securityMoves,
      observedFiles: manifestFiles,
      blindSpots: manifestBlindSpots,
    } = await this.runSecurityGate(options);

    const parseStart = performance.now();

    let graph: DependencyGraph;
    try {
      graph = await this.scanAll(options);
    } catch (err) {
      const parseGate: GateResult = {
        gate: 'parse',
        status: 'error',
        violations: [],
        baselinedCount: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: performance.now() - parseStart,
        cacheHits: 0,
        dependsOn: [],
      };
      const gates = [parseGate, skippedGate('architecture', ['parse']), securityGate];
      return {
        verdict: deriveVerdict(gates),
        gates,
        advisories: movedAdvisories(securityMoves),
        scannedAt,
        ungroundedComponents: [],
        ...untrustworthyScanScope(),
      };
    }

    const parseGate: GateResult = {
      gate: 'parse',
      status: 'green',
      violations: [],
      baselinedCount: 0,
      durationMs: performance.now() - parseStart,
      cacheHits: 0,
      dependsOn: [],
    };

    const archStart = performance.now();

    // Vacuous-green guards (ARCHITECTURE.md's severity-zero false-green invariant), both
    // surfaced as `error` — not `red`, not a silent drop (ADR 008: the architecture gate itself
    // couldn't produce a trustworthy verdict, same category as a scanner crash above):
    // 1. Every declared component must have at least one file classified to it this scan
    //    (`empty: 'allow' | 'until-populated'` opts out, ADR 003 + its greenfield-mode amendment).
    //    The TypeScript scanner independently enforces the selector-based half of this doctrine
    //    (`validateComponents`, plugin-typescript scanner.ts) at parse time; this
    //    classification-based check is plugin-independent and additionally catches a component
    //    fully shadowed by an earlier component's selector under first-match-wins — its rules
    //    would otherwise evaluate vacuously green. An opted-out-but-still-empty component isn't
    //    silently green either way: `findUngroundedComponents` below surfaces it (R1).
    // 2. Every ComponentRef a rule embeds (hand-authored or `.align/generated-rules.json`-merged,
    //    ADR 011) must name a component present in the registry — otherwise `evaluateRule`
    //    simply never matches the stale name and the rule silently drops out.
    // 3. Every `custom.host` rule must name a registered host predicate — an unregistered
    //    predicate is an unevaluatable rule reporting green. `this.hostPredicates`' key set is
    //    the real registered-name set once the CLI composition root injects one; a repo with no
    //    `hostRules` export gets the empty default, same as before registration existed.
    const classifiedComponents = new Set(graph.nodes.map((n) => n.component));
    try {
      // Selector-syntax lint first: an unsupported glob (character class, extglob, nested/range
      // brace, leading `!`) fails here with a precise message, before the classification-based
      // checks below could report it as a confusing zero-match — and regardless of `empty` policy.
      validateSelectorSyntax(this.ruleset.components);
      validateClassifiedComponents(this.ruleset.components, classifiedComponents);
      validateRuleComponentRefs(this.ruleset.rules, this.ruleset.components);
      validateHostRules(this.ruleset.rules, new Set(this.hostPredicates.keys()));
    } catch (err) {
      const gates = [parseGate, errorGate(err, archStart), securityGate];
      return {
        verdict: deriveVerdict(gates),
        gates,
        advisories: [
          ...buildUncertaintyAdvisories(graph.uncertain),
          ...buildScanBlindSpotAdvisories(graph.blindSpots),
          ...movedAdvisories(securityMoves),
        ],
        scannedAt,
        ungroundedComponents: [],
        ...untrustworthyScanScope(),
      };
    }

    // `security.manifest.*` rules never reach here — `ruleCategoryOf` partitions `RulesetIR.rules`
    // between this graph-based pipeline and `runSecurityGate`'s manifest-based one (ADR 013), two
    // disjoint scan domains that must never be evaluated through each other's dispatcher.
    const architectureRules = this.ruleset.rules.filter((rule) => ruleCategoryOf(rule) === 'architecture');

    // A registered predicate that throws (`HostPredicateExecutionError`) surfaces here — the
    // reference-validity invariant's sibling (ADR 008 amendment): a buggy predicate must never be
    // a silent pass, so it's caught at the same granularity as the guard-step failures above,
    // never allowed to abort the process with an unattributed stack trace.
    const allViolations: Violation[] = [];
    try {
      for (const rule of architectureRules) {
        const violations = evaluateRule(rule, graph, this.ruleset.components, this.hostPredicates);
        allViolations.push(...violations);
      }
    } catch (err) {
      const gates = [parseGate, errorGate(err, archStart), securityGate];
      return {
        verdict: deriveVerdict(gates),
        gates,
        advisories: [
          ...buildUncertaintyAdvisories(graph.uncertain),
          ...buildScanBlindSpotAdvisories(graph.blindSpots),
          ...movedAdvisories(securityMoves),
        ],
        scannedAt,
        ungroundedComponents: [],
        ...untrustworthyScanScope(),
      };
    }

    // Move-transfer (ADR 006), run on every check — not just `baseline prune` — so a renamed
    // file whose violation was already baselined doesn't turn CI red for one cycle. Mutates the
    // store in place; the CLI/MCP surface persists the updated snapshot when transfers occurred.
    // `knownFiles` is this gate's own scan domain (FRAGILE #7 fix, bug hunt 2026-08-03) — the
    // graph's node files, never derived from `allViolations` (a fixed file has no violations, so
    // deriving from violations would make every fixed file look deleted and defeat the fix).
    const knownFiles = new Set(graph.nodes.map((n) => n.file));
    // `graph.blindSpots` (ADR 028, generalizing ADR 027's F1 fix): passed through so a file this
    // scan declined to look at — for ANY of the six reasons, not just an auto-excluded checkout —
    // is never mistaken for a real rename by `applyMoves`; see `store.ts`'s `reconcileMoves` doc
    // comment. This is the unguarded path both ADRs named: unlike `baseline prune`, `align check`
    // runs this on every invocation with no completeness gate at all, so it is the one place the fix
    // matters even without `--allow-incomplete`.
    const moves = this.baselineStore.reconcileMoves(allViolations, knownFiles, graph.blindSpots);

    const newViolations = allViolations.filter((v) => !this.baselineStore.isBaselined(v.id));
    const baselinedCount = allViolations.length - newViolations.length;
    const rulesWithNoViolations = architectureRules.filter(
      (rule) => !allViolations.some((v) => v.ruleId === rule.id),
    ).length;

    const architectureGate: GateResult = {
      gate: 'architecture',
      status: newViolations.length > 0 ? 'red' : 'green',
      violations: newViolations,
      baselinedCount,
      passCount: rulesWithNoViolations,
      durationMs: performance.now() - archStart,
      cacheHits: 0,
      dependsOn: ['parse'],
    };

    const advisories: Advisory[] = [
      ...buildUncertaintyAdvisories(graph.uncertain),
      ...buildScanBlindSpotAdvisories([...graph.blindSpots, ...manifestBlindSpots]),
      ...movedAdvisories([...moves, ...securityMoves]),
      // ADR 017 Part A: computed after evaluation succeeds (same "trustworthy ruleset" precondition
      // as `ungroundedComponents` below) — an ungrounded external selector is vacuously green, not
      // a failure, so it never affects `verdict`, only visibility.
      ...buildUngroundedExternalSelectorAdvisories(architectureRules, graph.externalNodes),
      // FRAGILE #8 (bug hunt 2026-08-03): computed after `reconcileMoves` above, against the
      // post-reconcile baseline snapshot, so a `metric` entry that just transferred (file rename)
      // is compared under its new fingerprint rather than momentarily looking unbaselined. Advisory
      // only — never touches `verdict` or any fingerprint.
      ...buildBaselineGrowthAdvisories(allViolations, this.baselineStore.show()),
    ];

    const gates = [parseGate, architectureGate, securityGate];
    const verdict = deriveVerdict(gates);
    // R1 (greenfield mode): computed once the guard step above has proven every component name
    // is trustworthy — reuses the same classification set `validateClassifiedComponents` just
    // validated against, no second pass over the graph.
    const ungroundedComponents = findUngroundedComponents(this.ruleset.components, classifiedComponents);
    return {
      verdict,
      gates,
      advisories,
      scannedAt,
      ungroundedComponents,
      // UNION of both walkers, unlike `observedFiles` right below it, and the difference is not an
      // inconsistency. `observedFiles` answers "which files did THIS gate reason over", which is
      // per-gate by construction (ADR 028 §5). `blindSpots` answers "which paths did this run fail
      // to look at", which is a property of the repository, not of a gate — and its consumer is
      // `align baseline prune`'s retention, which partitions entries from BOTH domains through one
      // set. Narrowing it to the source domain would leave every manifest entry unprotected by the
      // very record F3 added for them.
      blindSpots: [...graph.blindSpots, ...manifestBlindSpots],
      // The two domains stay SEPARATE (ADR 028 §5): `source` is this gate's own `knownFiles`, the
      // exact set `reconcileMoves` above reasoned over, and `manifest` is the security gate's, the
      // exact set ITS `reconcileMoves` reasoned over. The deleted `knownFiles()` unioned them, so
      // `prune` reasoned over a set `check` never used — merging also mis-classifies, since `.json`
      // is an asset extension to the source walker but a first-class file to the manifest walker.
      observedFiles: { source: knownFiles, manifest: manifestFiles },
    };
  }

  /**
   * `security` gate (ADR 013): scans the manifest domain (root + workspace `package.json` +
   * `pnpm-lock.yaml`, `@spikedpunch/align-plugin-typescript`'s `NodeManifestScanner` in real deployments) and
   * evaluates every `security.manifest.*` rule against it via `evaluateManifestRule`. Always
   * `dependsOn: []` (ADR 008's always-run carve-out) — a manifest scan failure is this gate's own
   * `error`, never cascades from or into the architecture gate's status.
   */
  private async runSecurityGate(options: CheckOptions): Promise<{
    readonly gateResult: GateResult;
    /** The security gate's own transfers, carried whole rather than counted, so the advisory can
     * name what moved onto what (LEDGER D015). */
    readonly moved: readonly MovedEntry[];
    /** This gate's own observed file set, carried onto `CheckRun.observedFiles.manifest` (ADR 028
     * §5) so `align baseline prune` reads the manifest domain off the run instead of walking it a
     * second time. Empty when the manifest scan threw — an inventory that failed to build observed
     * nothing, and reporting a partial set as if it were the domain is the false-completeness shape
     * this ADR exists to stop. */
    readonly observedFiles: ReadonlySet<RepoRelativePath>;
    /** This domain's own blind spots (ADR 028 F3), carried out so `CheckRun.blindSpots` can be the
     * union of both walkers. Empty when the manifest scan threw. */
    readonly blindSpots: readonly ScanBlindSpot[];
  }> {
    const start = performance.now();
    const securityRules = this.ruleset.rules.filter(
      (rule): rule is SecurityManifestRule => ruleCategoryOf(rule) === 'security',
    );

    let inventory;
    try {
      inventory = await this.manifestScanner.scan({ rootDir: options.rootDir, excludes: options.excludes });
    } catch (err) {
      return {
        gateResult: {
          gate: 'security',
          status: 'error',
          violations: [],
          baselinedCount: 0,
          errorMessage: err instanceof Error ? err.message : String(err),
          durationMs: performance.now() - start,
          cacheHits: 0,
          dependsOn: [],
        },
        moved: [],
        observedFiles: new Set<RepoRelativePath>(),
        blindSpots: [],
      };
    }

    const allViolations: Violation[] = [];
    for (const rule of securityRules) {
      allViolations.push(...evaluateManifestRule(rule, inventory));
    }

    // `knownFiles` is this gate's own scan domain (FRAGILE #7 fix, bug hunt 2026-08-03) — the
    // manifest inventory's files, a deliberately disjoint scan domain from the graph above
    // (ADR 013) — never derived from `allViolations` (see the architecture gate's comment above).
    const knownFiles = new Set(inventory.manifests.map((m) => m.file));
    // `inventory.blindSpots` (ADR 028 F3, 2026-08-17). This argument used to be `[]`, defended by a
    // long comment arguing the manifest domain could never lose a manifest for a scan-scope reason.
    // The nested-checkout half of that was true and is still pinned by an executable test
    // (`plugin-typescript/test/manifest.test.ts`) — this domain performs no `.git` auto-exclusion.
    // The rest was false: `scanManifests` had its own unrecorded exits, and one of them was a real
    // forged-transfer window. A `package.json` inside an unreadable directory is on disk, absent
    // from the inventory, covered by no blind spot, and reads absent to the existence probe
    // (`existsSync` swallows the `EACCES`), so it reached the content-fingerprint match — where
    // collisions are the NORM, not the exception, because a manifest violation's snippet is the
    // dependency line itself and workspace packages pin the same dependencies. The walker now
    // records what it could not turn into a record, and those paths route here.
    //
    // Still per-domain, NOT merged with `graph.blindSpots` (ADR 028 §5): a source blind spot can
    // never explain a missing manifest, and passing it here would suppress a legitimate move-rescue
    // for a manifest that genuinely moved.
    const moves = this.baselineStore.reconcileMoves(allViolations, knownFiles, inventory.blindSpots);
    const newViolations = allViolations.filter((v) => !this.baselineStore.isBaselined(v.id));
    const baselinedCount = allViolations.length - newViolations.length;
    const rulesWithNoViolations = securityRules.filter(
      (rule) => !allViolations.some((v) => v.ruleId === rule.id),
    ).length;

    return {
      gateResult: {
        gate: 'security',
        status: newViolations.length > 0 ? 'red' : 'green',
        violations: newViolations,
        baselinedCount,
        passCount: rulesWithNoViolations,
        durationMs: performance.now() - start,
        cacheHits: 0,
        dependsOn: [],
      },
      moved: moves,
      observedFiles: knownFiles,
      blindSpots: inventory.blindSpots,
    };
  }

  private async scanAll(options: CheckOptions): Promise<DependencyGraph> {
    const plugins = this.registry.getAllPlugins();
    if (plugins.length === 0) {
      throw new Error('No language plugins registered — nothing to scan.');
    }
    // v1 has exactly one plugin; merging is written generically so a second plugin is additive.
    const graphs = await Promise.all(
      plugins.map((plugin) =>
        plugin.scanner.scan({
          rootDir: options.rootDir,
          components: this.ruleset.components,
          excludes: options.excludes,
          ...(options.includeNestedCheckouts === undefined ? {} : { includeNestedCheckouts: options.includeNestedCheckouts }),
        }),
      ),
    );
    if (graphs.length === 1) {
      const only = graphs[0];
      if (only === undefined) throw new Error('unreachable: graphs.length === 1');
      return only;
    }
    // Dedup external nodes by id across plugins (Stage 5 infra) — two plugins could both see an
    // import of the same external package name; the same `id`-keyed-Map dedup the scanner itself
    // uses within one scan.
    const externalNodesById = new Map<string, DependencyGraph['externalNodes'][number]>();
    for (const g of graphs) for (const n of g.externalNodes) externalNodesById.set(n.id, n);
    // Union the blind spots the same way (Stage 5's multi-plugin merge is written generically; a
    // shared subtree could in principle be walked by more than one plugin). Deduped on path AND
    // reason, not path alone: two plugins can decline the same path for different reasons, and
    // collapsing those would silently drop one — union in the SAFE direction, since every extra
    // record only widens what is retained rather than what is deleted.
    const blindSpotsByKey = new Map<string, ScanBlindSpot>();
    for (const g of graphs) for (const spot of g.blindSpots) blindSpotsByKey.set(`${spot.path}\u0000${JSON.stringify(spot.reason)}`, spot);
    const blindSpots = [...blindSpotsByKey.values()].sort((a, b) => a.path.localeCompare(b.path));
    return {
      nodes: graphs.flatMap((g) => g.nodes),
      edges: graphs.flatMap((g) => g.edges),
      externalNodes: [...externalNodesById.values()],
      externalEdges: graphs.flatMap((g) => g.externalEdges),
      uncertain: graphs.flatMap((g) => g.uncertain),
      blindSpots,
      scannedAt: Math.min(...graphs.map((g) => g.scannedAt)),
    };
  }
}

/** Shared by every `architecture` gate `error` path (guard-step failures, predicate exceptions) —
 * ADR 008: `error` is categorically distinct from `red`, always halts and escalates, never enters
 * an LLM-facing payload as prose (only `errorMessage`, a plain string). */
function errorGate(err: unknown, archStart: number): GateResult {
  return {
    gate: 'architecture',
    status: 'error',
    violations: [],
    baselinedCount: 0,
    errorMessage: err instanceof Error ? err.message : String(err),
    durationMs: performance.now() - archStart,
    cacheHits: 0,
    dependsOn: ['parse'],
  };
}

/**
 * The scan-scope half of a `CheckRun` on a path where no trustworthy scan scope exists — every
 * early return from `check()` where a gate errored. Empty `blindSpots` and empty `observedFiles`
 * move TOGETHER and that is the point: "these files were observed, and nothing was invisible" is a
 * completeness claim, so reporting an observed set beside a zeroed blind-spot record would assert a
 * guarantee the run cannot back. Both empty says "this run knows nothing about scan scope", which is
 * true and errs toward retention in every consumer.
 *
 * The manifest domain is zeroed here too even on the parse-error path, where the security gate DID
 * evaluate. That is deliberate and costs nothing: every destructive consumer must call
 * `refuseIfRunErrored` (ADR 023 tier 1, no override) before it reads either field, so an errored run
 * never reaches code that would look — and if that guard were ever bypassed, an empty set makes
 * `prune` retain rather than delete.
 *
 * A fresh `Set` per call rather than a shared frozen constant: `ReadonlySet` is a compile-time view,
 * not a runtime guarantee, and one shared instance handed to every caller is a cross-run aliasing
 * hazard for the sake of an allocation that happens only on error paths.
 */
function untrustworthyScanScope(): Pick<CheckRun, 'blindSpots' | 'observedFiles'> {
  return {
    blindSpots: [],
    observedFiles: { source: new Set<RepoRelativePath>(), manifest: new Set<RepoRelativePath>() },
  };
}

function skippedGate(gate: GateResult['gate'], dependsOn: readonly GateResult['gate'][]): GateResult {
  return {
    gate,
    status: 'skipped',
    violations: [],
    baselinedCount: 0,
    durationMs: 0,
    cacheHits: 0,
    dependsOn,
  };
}

/** Shared advisory-shape builder for move transfers (ADR 006) — the architecture gate's own
 * moves and the security gate's own moves are reconciled separately (two independent
 * `reconcileMoves` calls against disjoint violation sets, since a manifest violation's content
 * fingerprint never collides with a graph-based one) but reported as one combined advisory,
 * matching the single `baseline-moved` advisory shape every existing caller already expects. */
function movedAdvisories(moves: readonly MovedEntry[]): Advisory[] {
  if (moves.length === 0) return [];
  return [{ kind: 'baseline-moved', message: describeMovedEntries(moves) }];
}

function deriveVerdict(gates: readonly GateResult[]): CheckRun['verdict'] {
  if (gates.some((g) => g.status === 'error')) return 'error';
  if (gates.some((g) => g.status === 'red')) return 'red';
  return 'green';
}
