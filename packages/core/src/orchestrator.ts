import type { DependencyGraph } from './types/graph.js';
import type { RulesetIR } from './types/ir.js';
import type { Violation } from './types/violation.js';
import type { BaselineStore } from './baseline/store.js';
import type { Advisory, CheckRun, GateResult } from './gates/types.js';
import { buildUncertaintyAdvisories } from './gates/advisories.js';
import type { PluginRegistry } from './plugin/registry.js';
import { evaluateRule } from './rules/evaluators.js';
import { validateRuleComponentRefs } from './rules/component-refs.js';
import { validateHostRules } from './rules/host-rules.js';
import { validateClassifiedComponents } from './components/registry.js';

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
  ) {}

  async check(options: CheckOptions): Promise<CheckRun> {
    const scannedAt = Date.now();
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
      return {
        verdict: 'error',
        gates: [parseGate, skippedGate('architecture', ['parse'])],
        advisories: [],
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
    // 3. Every `custom.host` rule must name a registered host predicate — `evaluateRule` returns
    //    zero violations for the kind (v1 has no host-rule execution mechanism), so an
    //    unregistered predicate is an unevaluatable rule reporting green. v1 registers none
    //    (empty set below — the parameter is the growth path for a future predicate registry).
    try {
      validateClassifiedComponents(this.ruleset.components, new Set(graph.nodes.map((n) => n.component)));
      validateRuleComponentRefs(this.ruleset.rules, this.ruleset.components);
      validateHostRules(this.ruleset.rules, new Set<string>());
    } catch (err) {
      const architectureGate: GateResult = {
        gate: 'architecture',
        status: 'error',
        violations: [],
        baselinedCount: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: performance.now() - archStart,
        cacheHits: 0,
        dependsOn: ['parse'],
      };
      return {
        verdict: 'error',
        gates: [parseGate, architectureGate],
        advisories: [...buildUncertaintyAdvisories(graph.uncertain)],
        scannedAt,
      };
    }

    const allViolations: Violation[] = [];
    for (const rule of this.ruleset.rules) {
      const violations = evaluateRule(rule, graph, this.ruleset.components);
      allViolations.push(...violations);
    }

    // Move-transfer (ADR 006), run on every check — not just `baseline prune` — so a renamed
    // file whose violation was already baselined doesn't turn CI red for one cycle. Mutates the
    // store in place; the CLI/MCP surface persists the updated snapshot when transfers occurred.
    const moves = this.baselineStore.reconcileMoves(allViolations);

    const newViolations = allViolations.filter((v) => !this.baselineStore.isBaselined(v.id));
    const baselinedCount = allViolations.length - newViolations.length;
    const rulesWithNoViolations = this.ruleset.rules.filter(
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

    const advisories: Advisory[] = [...buildUncertaintyAdvisories(graph.uncertain)];
    if (moves.length > 0) {
      advisories.push({
        kind: 'baseline-moved',
        message: `${moves.length} ${moves.length === 1 ? 'entry' : 'entries'} transferred (file moves).`,
      });
    }

    const gates = [parseGate, architectureGate];
    const verdict = deriveVerdict(gates);
    return { verdict, gates, advisories, scannedAt };
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
    return {
      nodes: graphs.flatMap((g) => g.nodes),
      edges: graphs.flatMap((g) => g.edges),
      uncertain: graphs.flatMap((g) => g.uncertain),
      scannedAt: Math.min(...graphs.map((g) => g.scannedAt)),
    };
  }
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

function deriveVerdict(gates: readonly GateResult[]): CheckRun['verdict'] {
  if (gates.some((g) => g.status === 'error')) return 'error';
  if (gates.some((g) => g.status === 'red')) return 'red';
  return 'green';
}
