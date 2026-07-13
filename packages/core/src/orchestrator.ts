import type { DependencyGraph } from './types/graph.js';
import type { RulesetIR } from './types/ir.js';
import type { Violation } from './types/violation.js';
import { EMPTY_MANIFEST_INVENTORY, type ManifestScanner } from './types/manifest.js';
import type { BaselineStore } from './baseline/store.js';
import type { Advisory, CheckRun, GateResult } from './gates/types.js';
import { buildUncertaintyAdvisories } from './gates/advisories.js';
import type { PluginRegistry } from './plugin/registry.js';
import { evaluateRule } from './rules/evaluators.js';
import { evaluateManifestRule, type SecurityManifestRule } from './rules/manifest-evaluators.js';
import { ruleCategoryOf } from './rules/rule-category.js';
import { validateRuleComponentRefs } from './rules/component-refs.js';
import { validateHostRules, type HostPredicateRegistry } from './rules/host-rules.js';
import { validateClassifiedComponents } from './components/registry.js';

/** No predicates registered — the default for callers that don't inject one (most existing tests
 * exercise portable `arch.*` kinds only; a real deployment always gets a real registry from the
 * CLI composition root, `packages/cli/src/composition-root.ts`). */
const NO_HOST_PREDICATES: HostPredicateRegistry = new Map();

/** No-op default for callers that don't inject a real manifest scanner (most existing tests never
 * author `security.manifest.*` rules; a real deployment gets `@align/plugin-typescript`'s
 * `NodeManifestScanner` from the CLI composition root — core never imports plugin-typescript
 * directly, ADR 013/ARCHITECTURE.md §5). Returns the empty inventory, never throws — a repo with
 * no `security.manifest.*` rules authored never even calls this. */
const NO_MANIFEST_SCANNER: ManifestScanner = { scan: () => EMPTY_MANIFEST_INVENTORY };

export interface CheckOptions {
  readonly rootDir: string; // absolute filesystem path
  readonly excludes: readonly string[];
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
     * composition root wires in `@align/plugin-typescript`'s `NodeManifestScanner`. Defaults to a
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
    const { gateResult: securityGate, movedCount: securityMoves } = await this.runSecurityGate(options);

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
    //    (`allowEmpty: true` opts out, ADR 003). The TypeScript scanner independently enforces
    //    the selector-based half of this doctrine (`validateComponents`, plugin-typescript
    //    scanner.ts) at parse time; this classification-based check is plugin-independent and
    //    additionally catches a component fully shadowed by an earlier component's selector under
    //    first-match-wins — its rules would otherwise evaluate vacuously green.
    // 2. Every ComponentRef a rule embeds (hand-authored or `.align/generated-rules.json`-merged,
    //    ADR 011) must name a component present in the registry — otherwise `evaluateRule`
    //    simply never matches the stale name and the rule silently drops out.
    // 3. Every `custom.host` rule must name a registered host predicate — an unregistered
    //    predicate is an unevaluatable rule reporting green. `this.hostPredicates`' key set is
    //    the real registered-name set once the CLI composition root injects one; a repo with no
    //    `hostRules` export gets the empty default, same as before registration existed.
    try {
      validateClassifiedComponents(this.ruleset.components, new Set(graph.nodes.map((n) => n.component)));
      validateRuleComponentRefs(this.ruleset.rules, this.ruleset.components);
      validateHostRules(this.ruleset.rules, new Set(this.hostPredicates.keys()));
    } catch (err) {
      const gates = [parseGate, errorGate(err, archStart), securityGate];
      return {
        verdict: deriveVerdict(gates),
        gates,
        advisories: [...buildUncertaintyAdvisories(graph.uncertain), ...movedAdvisories(securityMoves)],
        scannedAt,
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
        advisories: [...buildUncertaintyAdvisories(graph.uncertain), ...movedAdvisories(securityMoves)],
        scannedAt,
      };
    }

    // Move-transfer (ADR 006), run on every check — not just `baseline prune` — so a renamed
    // file whose violation was already baselined doesn't turn CI red for one cycle. Mutates the
    // store in place; the CLI/MCP surface persists the updated snapshot when transfers occurred.
    const moves = this.baselineStore.reconcileMoves(allViolations);

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
      ...movedAdvisories(moves.length + securityMoves),
    ];

    const gates = [parseGate, architectureGate, securityGate];
    const verdict = deriveVerdict(gates);
    return { verdict, gates, advisories, scannedAt };
  }

  /**
   * `security` gate (ADR 013): scans the manifest domain (root + workspace `package.json` +
   * `pnpm-lock.yaml`, `@align/plugin-typescript`'s `NodeManifestScanner` in real deployments) and
   * evaluates every `security.manifest.*` rule against it via `evaluateManifestRule`. Always
   * `dependsOn: []` (ADR 008's always-run carve-out) — a manifest scan failure is this gate's own
   * `error`, never cascades from or into the architecture gate's status.
   */
  private async runSecurityGate(options: CheckOptions): Promise<{ readonly gateResult: GateResult; readonly movedCount: number }> {
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
        movedCount: 0,
      };
    }

    const allViolations: Violation[] = [];
    for (const rule of securityRules) {
      allViolations.push(...evaluateManifestRule(rule, inventory));
    }

    const moves = this.baselineStore.reconcileMoves(allViolations);
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
      movedCount: moves.length,
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
    return {
      nodes: graphs.flatMap((g) => g.nodes),
      edges: graphs.flatMap((g) => g.edges),
      externalNodes: [...externalNodesById.values()],
      externalEdges: graphs.flatMap((g) => g.externalEdges),
      uncertain: graphs.flatMap((g) => g.uncertain),
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

/** Shared advisory-shape builder for move-transfer counts (ADR 006) — the architecture gate's own
 * moves and the security gate's own moves are reconciled separately (two independent
 * `reconcileMoves` calls against disjoint violation sets, since a manifest violation's content
 * fingerprint never collides with a graph-based one) but reported as one combined advisory,
 * matching the single `baseline-moved` advisory shape every existing caller already expects. */
function movedAdvisories(count: number): Advisory[] {
  if (count === 0) return [];
  return [{ kind: 'baseline-moved', message: `${count} ${count === 1 ? 'entry' : 'entries'} transferred (file moves).` }];
}

function deriveVerdict(gates: readonly GateResult[]): CheckRun['verdict'] {
  if (gates.some((g) => g.status === 'error')) return 'error';
  if (gates.some((g) => g.status === 'red')) return 'red';
  return 'green';
}
