/**
 * Fluent authoring surface -> IR serializer (ADR 002). Exported as the `@spikedpunch/align-core/dsl` subpath
 * — folded into `@spikedpunch/align-core` for v1 (ARCHITECTURE.md §5: single consumer, extraction to a
 * standalone `@spikedpunch/align-dsl` package is cheap and deferred until a second consumer needs it).
 */
import { toComponentName, toRuleId, type RuleId } from '../types/branded.js';
import type { ComponentDefinitionIR, EmptyPolicy, FileSelector, RuleIR, RulesetIR } from '../types/ir.js';
import { rulesetIRSchema } from '../types/ir.js';
import {
  makeArchFactory,
  makeCustomFactory,
  makeSecurityFactory,
  type ComponentContext as ComponentContextBase,
  type ComponentToken,
  type RuleBuilder,
} from './factories.js';

export * from './factories.js';
export * from './verb-manifest.js';

// ---------------------------------------------------------------------------------------------
// Component declaration shorthand
// ---------------------------------------------------------------------------------------------

export type ComponentDeclaration =
  | string
  | {
      readonly pattern: string;
      /**
       * @deprecated Use `empty: 'allow'` instead — kept for back-compat (align's own dogfood
       * config history and external adopters, e.g. kluster's `sdd` component, already authored
       * `allowEmpty: true`; it keeps working, unchanged, as an alias). `allowEmpty: true` resolves
       * to `empty: 'allow'` when `empty` itself is not also set; `empty` wins if both are present.
       */
      readonly allowEmpty?: boolean;
      /**
       * Greenfield mode (IMPLEMENTATION_PLAN.md Design Reserve "Greenfield mode", ADR 003
       * amendment) — the empty-selector policy, as a 3-state discriminant:
       * - `'fail'` (default): a component matching zero files is a load-time error (unchanged
       *   ADR 003 empty-selector-fails-by-default safety).
       * - `'allow'`: empty tolerated permanently — same as `allowEmpty: true`, now additionally
       *   surfaced as an `ungrounded-component` advisory in `align check` (R1) instead of an
       *   indistinguishable plain `green`.
       * - `'until-populated'`: empty tolerated + surfaced the same way, but self-heals — once the
       *   component has >=1 classified file, the empty-check simply stops firing and its rules
       *   evaluate normally (no manual flag flip). Use this for architecture-first authoring:
       *   components declared before any code exists.
       */
      readonly empty?: EmptyPolicy;
    };

export type ComponentsInput = Record<string, ComponentDeclaration>;

function parseSelector(pattern: string): FileSelector {
  if (pattern.startsWith('package:')) {
    return { kind: 'package', packageNames: [pattern.slice('package:'.length)] };
  }
  return { kind: 'glob', patterns: [pattern] };
}

function resolveComponentDefinition(name: string, decl: ComponentDeclaration): ComponentDefinitionIR {
  if (typeof decl === 'string') {
    return { name, selector: parseSelector(decl), empty: 'fail' };
  }
  // `empty` wins if both are authored; `allowEmpty: true` alone resolves to `empty: 'allow'`
  // (deprecated-alias back-compat — see the `ComponentDeclaration` doc comment above).
  const empty: EmptyPolicy = decl.empty ?? (decl.allowEmpty === true ? 'allow' : 'fail');
  return { name, selector: parseSelector(decl.pattern), empty };
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
// Re-exported from `./factories.js` (single verb-surface source, `dsl/verb-manifest.ts` reads the
// same factory constructors) — aliased here only to pin the `T extends ComponentsInput` bound
// `defineProject` needs.
// ---------------------------------------------------------------------------------------------

export type ComponentContext<T extends ComponentsInput> = ComponentContextBase<T>;

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
