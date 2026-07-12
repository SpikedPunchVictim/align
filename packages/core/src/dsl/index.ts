/**
 * Fluent authoring surface -> IR serializer (ADR 002). Exported as the `@align/core/dsl` subpath
 * — folded into `@align/core` for v1 (ARCHITECTURE.md §5: single consumer, extraction to a
 * standalone `@align/dsl` package is cheap and deferred until a second consumer needs it).
 */
import { toComponentName, toRuleId, type ComponentName, type RuleId } from '../types/branded.js';
import type {
  ArchLayersRule,
  ArchMetricRule,
  ArchNoCyclesRule,
  ArchNoDependencyRule,
  ComponentDefinitionIR,
  CustomHostRule,
  FileSelector,
  RuleIR,
  RuleProvenance,
  RulesetIR,
  SecurityManifestNewDependencyRule,
  SecurityManifestSourceHygieneRule,
} from '../types/ir.js';
import { rulesetIRSchema } from '../types/ir.js';

// ---------------------------------------------------------------------------------------------
// Component declaration shorthand
// ---------------------------------------------------------------------------------------------

export type ComponentDeclaration = string | { readonly pattern: string; readonly allowEmpty?: boolean };

export type ComponentsInput = Record<string, ComponentDeclaration>;

function parseSelector(pattern: string): FileSelector {
  if (pattern.startsWith('package:')) {
    return { kind: 'package', packageNames: [pattern.slice('package:'.length)] };
  }
  return { kind: 'glob', patterns: [pattern] };
}

function resolveComponentDefinition(name: string, decl: ComponentDeclaration): ComponentDefinitionIR {
  const pattern = typeof decl === 'string' ? decl : decl.pattern;
  const allowEmpty = typeof decl === 'string' ? false : (decl.allowEmpty ?? false);
  return { name, selector: parseSelector(pattern), allowEmpty };
}

// ---------------------------------------------------------------------------------------------
// Reserved-name type guard (ADR 002): component keys colliding with reserved factory names are
// compile errors, enforced at the type level.
// ---------------------------------------------------------------------------------------------

type ReservedFactoryName = 'arch' | 'metrics' | 'gates' | 'security' | 'custom';

/** Forces a type error at the call site of `defineProject` when a component key shadows a
 * reserved factory name — the colliding key's required value type collapses to `never`. */
type NoReservedComponentKeys<T> = {
  readonly [K in Extract<keyof T, ReservedFactoryName>]?: never;
};

// ---------------------------------------------------------------------------------------------
// ComponentContext: c.<key> tokens + c.arch factory, generically typed from component keys.
// ---------------------------------------------------------------------------------------------

export interface ComponentToken {
  readonly name: ComponentName;
}

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

function ruleBuilder(makeBase: (provenance: RuleProvenance) => readonly RuleIR[]): RuleBuilder {
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

interface LayerRuleBuilder {
  /** dependencies outside this allowlist are violations */
  canOnlyDependOn(...refs: readonly ComponentToken[]): RuleBuilder;
  /** dependencies on this denylist are violations; everything else is permitted */
  cannotDependOn(...refs: readonly ComponentToken[]): RuleBuilder;
}

interface ComponentRuleBuilder {
  /** no other component may depend on this one, and it depends on none */
  isIsolated(): RuleBuilder;
  /** every file classified to this component must stay at or under `max` lines — `arch.metric`
   * (max-LOC), promoted 2026-07-12 on kluster ruleset evidence (IMPLEMENTATION_PLAN.md's Promotion
   * log: two 2,100+-line files were structurally invisible to every dependency/cycle rule). Only
   * the `loc` metric is promoted — `fan-in`/`fan-out`/`instability` verbs stay reserved pending
   * their own evidence. */
  maxLinesPerFile(max: number): RuleBuilder;
}

interface NoCyclesOptions {
  readonly includeTypeOnly?: boolean;
}

interface ArchFactory {
  layer(token: ComponentToken): LayerRuleBuilder;
  component(token: ComponentToken): ComponentRuleBuilder;
  /** Not in ADR 002's illustrative vocabulary table, but `arch.no-cycles` is a v1 IR rule kind
   * with no other documented authoring path — added following the same negation-free, positive
   * verb convention (deviation noted in the Stage 1 final report). */
  noCycles(scope?: ComponentToken | 'repo', options?: NoCyclesOptions): RuleBuilder;
}

interface CustomFactory {
  /** Produces a `custom.host` IR rule (ADR 002's escape hatch, docs/proposals/rule-expansion-
   * evaluation.md §B.0) referencing a predicate registered by the same name in align.config.ts's
   * sibling `hostRules` export (`{ [hostRuleName]: HostPredicate }`, `@align/core`'s
   * `HostPredicateRegistry`) — not passed through `defineProject` itself, since `RulesetIR` is
   * portable JSON (ADR 002) and predicates are functions. `defineProject` only builds the
   * reference (`hostRuleName`, `portable: false`); `validateHostRules` (the orchestrator's guard
   * step) is what confirms the name actually resolves to a registered predicate at check time —
   * the same "reference must resolve or the gate errors" doctrine every other selector in this
   * file already follows (ADR 008 amendment). */
  host(hostRuleName: string): RuleBuilder;
}

export type ComponentContext<T extends ComponentsInput> = {
  readonly [K in keyof T]: ComponentToken;
} & {
  readonly arch: ArchFactory;
  readonly custom: CustomFactory;
  readonly security: SecurityFactory;
};

function makeCustomFactory(): CustomFactory {
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
// spike/MANIFEST_PROBE_REPORT.md probe evidence). First-class kinds, not `custom.host` escape
// hatches: portable IR, tier-2 doc-authoring support (`build/tier2.ts`), full `.because()`
// treatment via the same `ruleBuilder()` every other verb in this file uses. Both verbs take no
// arguments — the manifest scan domain (root + workspace `package.json` + `pnpm-lock.yaml`) has no
// notion of align's file-classified components, so there is nothing to parameterize (mirrors
// `custom.host`'s no-`ComponentRef` shape, `rules/component-refs.ts`).
// ---------------------------------------------------------------------------------------------

interface SecurityManifestFactory {
  /** Any dependency specifier resolving to a git/http(s)/file/link source (not registry, not
   * `workspace:`) is a violation — `security.manifest.source-hygiene`. */
  sourceHygiene(): RuleBuilder;
  /** Every current runtime/dev dependency is fingerprinted (name + declaring manifest); baseline
   * consent (`align init` / `baseline accept`) seeds what's there today, so only a genuinely new
   * dependency added later shows red — `security.manifest.new-dependency`. */
  newDependencyGate(): RuleBuilder;
}

interface SecurityFactory {
  readonly manifest: SecurityManifestFactory;
}

function makeSecurityFactory(): SecurityFactory {
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

function makeArchFactory(allComponents: readonly ComponentToken[]): ArchFactory {
  return {
    layer(token: ComponentToken): LayerRuleBuilder {
      return {
        canOnlyDependOn(...refs: readonly ComponentToken[]): RuleBuilder {
          return ruleBuilder((provenance) => {
            const rule: ArchLayersRule = {
              kind: 'arch.layers',
              id: toRuleId(`arch.layers:${token.name}`),
              layers: [{ layer: token.name, canDependOn: refs.map((r) => r.name) }],
              provenance,
            };
            return [rule];
          });
        },
        cannotDependOn(...refs: readonly ComponentToken[]): RuleBuilder {
          return ruleBuilder((provenance) =>
            refs.map(
              (ref): ArchNoDependencyRule => ({
                kind: 'arch.no-dependency',
                id: toRuleId(`arch.no-dependency:${token.name}->${ref.name}`),
                from: token.name,
                to: ref.name,
                provenance,
              }),
            ),
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

// ---------------------------------------------------------------------------------------------
// defineProject
// ---------------------------------------------------------------------------------------------

export interface DefineProjectConfig<T extends ComponentsInput> {
  readonly components: T & NoReservedComponentKeys<T>;
  readonly rules?: (c: ComponentContext<T>) => readonly RuleBuilder[];
}

/**
 * `rules` is optional — `defineProject({ components })` alone is valid; zero-DSL day-one value
 * is unaffected by whether an architecture ruleset exists yet (ADR 002/009).
 */
export function defineProject<T extends ComponentsInput>(config: DefineProjectConfig<T>): RulesetIR {
  const componentEntries = Object.entries(config.components as ComponentsInput);
  const components: Record<string, ComponentDefinitionIR> = {};
  const tokens: Record<string, ComponentToken> = {};
  for (const [name, decl] of componentEntries) {
    components[name] = resolveComponentDefinition(name, decl);
    tokens[name] = { name: toComponentName(name) };
  }

  const context = {
    ...tokens,
    arch: makeArchFactory(Object.values(tokens)),
    custom: makeCustomFactory(),
    security: makeSecurityFactory(),
  } as ComponentContext<T>;

  const builders = config.rules?.(context) ?? [];

  const usedIds = new Set<string>();
  const rules: RuleIR[] = [];
  for (const builder of builders) {
    for (const rule of builder.build()) {
      rules.push({ ...rule, id: dedupeRuleId(rule.id, usedIds) } as RuleIR);
    }
  }

  return rulesetIRSchema.parse({ irVersion: '1', components, rules });
}

/** Semantic ids (e.g. `arch.no-dependency:api->ui`) are stable across unrelated config edits;
 * a numeric suffix is appended only on an actual collision (e.g. two `.cannotDependOn()` calls
 * naming the same pair). */
function dedupeRuleId(base: string, usedIds: Set<string>): RuleId {
  let candidate: string = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return toRuleId(candidate);
}
