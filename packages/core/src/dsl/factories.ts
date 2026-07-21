/**
 * DSL builder factories (ADR 002/013) — split out of `dsl/index.ts` so this module can be the
 * single source of truth for the verb surface: `dsl/index.ts`'s `defineProject` imports these
 * factory constructors to build `ComponentContext`, and `dsl/verb-manifest.ts` imports the same
 * constructors to runtime-introspect the verb table `align skill` renders (Stage 5,
 * IMPLEMENTATION_PLAN.md). Neither consumer hand-duplicates the verb list — both read this file.
 */
import { toRuleId, type ComponentName } from '../types/branded.js';
import type {
  ArchLayersRule,
  ArchMetricRule,
  ArchNoCyclesRule,
  ArchNoDependencyRule,
  CustomHostRule,
  DependencyTarget,
  RuleIR,
  RuleProvenance,
  SecurityManifestNewDependencyRule,
  SecurityManifestSourceHygieneRule,
} from '../types/ir.js';

// ---------------------------------------------------------------------------------------------
// ComponentContext: c.<key> tokens + c.arch factory, generically typed from component keys.
// ---------------------------------------------------------------------------------------------

export interface ComponentToken {
  readonly name: ComponentName;
}

// ---------------------------------------------------------------------------------------------
// `external(...)` — ADR 017 Part A: a permitted TARGET for `.cannotDependOn(...)` /
// `.canOnlyDependOn(...)` alongside `ComponentToken`s, matched against `graph.externalEdges`
// (never `graph.nodes`/`graph.edges`). A free function (not `c.external(...)`) — mirrors the ADR's
// own examples (`c.webShared.cannotDependOn(external('node:*'))`) and the "selector, not a
// component" distinction: unlike a `ComponentToken`, it is never a key of the components map.
// ---------------------------------------------------------------------------------------------

export interface ExternalSelectorToken {
  readonly kind: 'external';
  readonly pattern: string;
  readonly includeTypeOnly: boolean;
}

export interface ExternalSelectorOptions {
  /** Default `false` — matches runtime edges only (`import`/`reexport`/`dynamic`), mirroring
   * `arch.noCycles`'s existing `includeTypeOnly` option and its default. The browser-safety case
   * (`cannotDependOn(external('node:*'))`) wants the default off; the §8.3 core-purity case
   * (`cannotDependOn(external('react', { includeTypeOnly: true }))`) opts in because "must not
   * import framework *types*" specifically wants type-only edges caught too. */
  readonly includeTypeOnly?: boolean;
}

/** `external('node:*')`, `external('fs')`, `external('node:fs')`, `external('@scope/*')`,
 * `external('lodash')` — glob pattern matched against `ExternalPackageNode` at evaluation time
 * (`rules/external-match.ts`'s `externalSelectorMatchesNode`, semantics pinned in
 * `docs/ir-schema.md`). Produces a plain IR value (`{ kind: 'external', pattern, includeTypeOnly }`)
 * — no host code, so a rule naming one stays portable to `align check --untrusted` (ADR 014). */
export function external(pattern: string, opts?: ExternalSelectorOptions): ExternalSelectorToken {
  return { kind: 'external', pattern, includeTypeOnly: opts?.includeTypeOnly ?? false };
}

function isExternalSelectorToken(ref: DependencyRefToken): ref is ExternalSelectorToken {
  return 'pattern' in ref;
}

function toDependencyTarget(ref: DependencyRefToken): DependencyTarget {
  return isExternalSelectorToken(ref) ? { kind: 'external', pattern: ref.pattern, includeTypeOnly: ref.includeTypeOnly } : ref.name;
}

/** A `.cannotDependOn(...)` / `.canOnlyDependOn(...)` argument: either a component (the original
 * shape) or an external selector (ADR 017 Part A's widening). */
export type DependencyRefToken = ComponentToken | ExternalSelectorToken;

export interface RuleBuilder {
  /** Hoists into `provenance.because` (ADR 002) — the single field feeding terminal output, IDE
   * hover, and future fix-prompt explanations. */
  because(text: string): RuleBuilder;
  /** Internal: finalizes into one or more concrete RuleIR nodes. Some verbs (`isIsolated()`,
   * `cannotDependOn()`) expand into multiple no-dependency rules. `id` is pre-filled with a
   * semantic, human-readable slug (e.g. `arch.no-dependency:api->ui`); `defineProject` only
   * appends a numeric suffix if two rules would otherwise collide, so ids stay stable across
   * config edits that don't touch the colliding rules themselves. */
  build(): readonly RuleIR[];
}

export function ruleBuilder(makeBase: (provenance: RuleProvenance) => readonly RuleIR[]): RuleBuilder {
  let provenance: RuleProvenance = {};
  const self: RuleBuilder = {
    because(text: string): RuleBuilder {
      provenance = { ...provenance, because: text };
      return self;
    },
    build(): readonly RuleIR[] {
      return makeBase(provenance);
    },
  };
  return self;
}

export interface LayerRuleBuilder {
  /** dependencies outside this allowlist are violations. Accepts `external(...)` selectors
   * alongside components (ADR 017 Part A) — naming >=1 external selector opts this layer's
   * external edges into evaluation (default-deny becomes expressible for externals, e.g. vscode's
   * browser-layer allow-list); a components-only call is unaffected (external edges stay ignored,
   * back-compat invariant). */
  canOnlyDependOn(...refs: readonly DependencyRefToken[]): RuleBuilder;
  /** dependencies on this denylist are violations; everything else is permitted. Accepts
   * `external(...)` selectors alongside components (ADR 017 Part A) — one `arch.no-dependency`
   * rule per listed ref, external or component alike. */
  cannotDependOn(...refs: readonly DependencyRefToken[]): RuleBuilder;
}

export interface ComponentRuleBuilder {
  /** no other component may depend on this one, and it depends on none */
  isIsolated(): RuleBuilder;
  /** every file classified to this component must stay at or under `max` lines — `arch.metric`
   * (max-LOC), promoted 2026-07-12 on kluster ruleset evidence (IMPLEMENTATION_PLAN.md's Promotion
   * log: two 2,100+-line files were structurally invisible to every dependency/cycle rule). Only
   * the `loc` metric is promoted — `fan-in`/`fan-out`/`instability` verbs stay reserved pending
   * their own evidence. */
  maxLinesPerFile(max: number): RuleBuilder;
}

export interface NoCyclesOptions {
  readonly includeTypeOnly?: boolean;
}

export interface ArchFactory {
  layer(token: ComponentToken): LayerRuleBuilder;
  component(token: ComponentToken): ComponentRuleBuilder;
  /** Not in ADR 002's illustrative vocabulary table, but `arch.no-cycles` is a v1 IR rule kind
   * with no other documented authoring path — added following the same negation-free, positive
   * verb convention (deviation noted in the Stage 1 final report). */
  noCycles(scope?: ComponentToken | 'repo', options?: NoCyclesOptions): RuleBuilder;
}

export interface CustomFactory {
  /** Produces a `custom.host` IR rule (ADR 002's escape hatch, docs/proposals/rule-expansion-
   * evaluation.md §B.0) referencing a predicate registered by the same name in align.config.ts's
   * sibling `hostRules` export (`{ [hostRuleName]: HostPredicate }`, `@spikedpunch/align-core`'s
   * `HostPredicateRegistry`) — not passed through `defineProject` itself, since `RulesetIR` is
   * portable JSON (ADR 002) and predicates are functions. `defineProject` only builds the
   * reference (`hostRuleName`, `portable: false`); `validateHostRules` (the orchestrator's guard
   * step) is what confirms the name actually resolves to a registered predicate at check time —
   * the same "reference must resolve or the gate errors" doctrine every other selector in this
   * file already follows (ADR 008 amendment). */
  host(hostRuleName: string): RuleBuilder;
}

export type ComponentContext<T extends Record<string, unknown>> = {
  readonly [K in keyof T]: ComponentToken;
} & {
  readonly arch: ArchFactory;
  readonly custom: CustomFactory;
  readonly security: SecurityFactory;
};

export function makeCustomFactory(): CustomFactory {
  return {
    host(hostRuleName: string): RuleBuilder {
      return ruleBuilder((provenance) => {
        const rule: CustomHostRule = {
          kind: 'custom.host',
          id: toRuleId(`custom.host:${hostRuleName}`),
          hostRuleName,
          portable: false,
          provenance,
        };
        return [rule];
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// `c.security.manifest` — the `security.manifest.*` rule kinds (ADR 013, promoted 2026-07-12 on
// docs/evidence/manifest-security-probe/MANIFEST_PROBE_REPORT.md probe evidence). First-class kinds, not `custom.host` escape
// hatches: portable IR, tier-2 doc-authoring support (`build/tier2.ts`), full `.because()`
// treatment via the same `ruleBuilder()` every other verb in this file uses. Both verbs take no
// arguments — the manifest scan domain (root + workspace `package.json` + `pnpm-lock.yaml`) has no
// notion of align's file-classified components, so there is nothing to parameterize (mirrors
// `custom.host`'s no-`ComponentRef` shape, `rules/component-refs.ts`).
// ---------------------------------------------------------------------------------------------

export interface SecurityManifestFactory {
  /** Any dependency specifier resolving to a git/http(s)/file/link source (not registry, not
   * `workspace:`) is a violation — `security.manifest.source-hygiene`. */
  sourceHygiene(): RuleBuilder;
  /** Every current runtime/dev dependency is fingerprinted (name + declaring manifest); baseline
   * consent (`align init` / `baseline accept`) seeds what's there today, so only a genuinely new
   * dependency added later shows red — `security.manifest.new-dependency`. */
  newDependencyGate(): RuleBuilder;
}

export interface SecurityFactory {
  readonly manifest: SecurityManifestFactory;
}

export function makeSecurityFactory(): SecurityFactory {
  return {
    manifest: {
      sourceHygiene(): RuleBuilder {
        return ruleBuilder((provenance) => {
          const rule: SecurityManifestSourceHygieneRule = {
            kind: 'security.manifest.source-hygiene',
            id: toRuleId('security.manifest.source-hygiene'),
            provenance,
          };
          return [rule];
        });
      },
      newDependencyGate(): RuleBuilder {
        return ruleBuilder((provenance) => {
          const rule: SecurityManifestNewDependencyRule = {
            kind: 'security.manifest.new-dependency',
            id: toRuleId('security.manifest.new-dependency'),
            provenance,
          };
          return [rule];
        });
      },
    },
  };
}

export function makeArchFactory(allComponents: readonly ComponentToken[]): ArchFactory {
  return {
    layer(token: ComponentToken): LayerRuleBuilder {
      return {
        canOnlyDependOn(...refs: readonly DependencyRefToken[]): RuleBuilder {
          return ruleBuilder((provenance) => {
            const rule: ArchLayersRule = {
              kind: 'arch.layers',
              id: toRuleId(`arch.layers:${token.name}`),
              layers: [{ layer: token.name, canDependOn: refs.map(toDependencyTarget) }],
              provenance,
            };
            return [rule];
          });
        },
        cannotDependOn(...refs: readonly DependencyRefToken[]): RuleBuilder {
          return ruleBuilder((provenance) =>
            refs.map((ref): ArchNoDependencyRule => {
              const isExternal = isExternalSelectorToken(ref);
              return {
                kind: 'arch.no-dependency',
                id: toRuleId(`arch.no-dependency:${token.name}->${isExternal ? `external:${ref.pattern}` : ref.name}`),
                from: token.name,
                to: toDependencyTarget(ref),
                provenance,
              };
            }),
          );
        },
      };
    },
    component(token: ComponentToken): ComponentRuleBuilder {
      return {
        isIsolated(): RuleBuilder {
          return ruleBuilder((provenance) => {
            const others = allComponents.filter((c) => c.name !== token.name);
            const rules: ArchNoDependencyRule[] = [];
            for (const other of others) {
              rules.push({
                kind: 'arch.no-dependency',
                id: toRuleId(`arch.no-dependency:${other.name}->${token.name}`),
                from: other.name,
                to: token.name,
                provenance,
              });
              rules.push({
                kind: 'arch.no-dependency',
                id: toRuleId(`arch.no-dependency:${token.name}->${other.name}`),
                from: token.name,
                to: other.name,
                provenance,
              });
            }
            return rules;
          });
        },
        maxLinesPerFile(max: number): RuleBuilder {
          return ruleBuilder((provenance) => {
            const rule: ArchMetricRule = {
              kind: 'arch.metric',
              id: toRuleId(`arch.metric:loc:${token.name}`),
              target: token.name,
              metric: 'loc',
              max,
              provenance,
            };
            return [rule];
          });
        },
      };
    },
    noCycles(scope?: ComponentToken | 'repo', options?: NoCyclesOptions): RuleBuilder {
      return ruleBuilder((provenance) => {
        const scopeValue = scope === undefined || scope === 'repo' ? 'repo' : scope.name;
        const rule: ArchNoCyclesRule = {
          kind: 'arch.no-cycles',
          id: toRuleId(`arch.no-cycles:${scopeValue}`),
          scope: scopeValue,
          includeTypeOnly: options?.includeTypeOnly ?? false,
          provenance,
        };
        return [rule];
      });
    },
  };
}
