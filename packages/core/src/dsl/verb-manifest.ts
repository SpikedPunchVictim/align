/**
 * DSL verb manifest (Stage 5, IMPLEMENTATION_PLAN.md "Elevated first items"): the single source
 * of truth `align skill`'s generated DSL-verb-table section reads from
 * (`packages/cli/src/skill/dsl-verbs.ts`).
 *
 * The verb *names* are runtime-introspected from the actual builder objects `factories.ts`
 * constructs — not re-typed by hand — by instantiating each factory with placeholder tokens and
 * walking `Object.keys()`. A hand-written verb added to `factories.ts` without a matching entry
 * here (or a stale entry left behind after a verb is removed) fails `describeDslVerbs()` fast
 * (CODING_BEST_PRACTICES.md's fail-fast doctrine) rather than silently drifting — the same
 * "generated from the live registry, never a hand-written prose list" discipline
 * `rule-kinds.ts`/`bullet-grammar.ts` apply on the CLI side.
 */
import { toComponentName } from '../types/branded.js';
import { makeArchFactory, makeCustomFactory, makeSecurityFactory, type ComponentToken } from './factories.js';

export interface DslVerbEntry {
  /** Dotted call path as authored, e.g. `arch.layer(x).canOnlyDependOn(...)`. */
  readonly path: string;
  readonly description: string;
  readonly producesRuleKind: readonly string[];
}

// Hand-maintained prose, keyed by the same dotted path `introspectVerbPaths()` below produces at
// runtime — this is the part `describeDslVerbs()` guarantees stays complete, not the part it
// guarantees stays accurate English; a verb whose *name* changes fails introspection matching
// (caught immediately), a verb whose *behavior* changes without a description update is a normal
// code-review miss like any other stale comment.
const VERB_DESCRIPTIONS: Record<string, Omit<DslVerbEntry, 'path'>> = {
  'arch.layer(x).canOnlyDependOn(...refs)': {
    description: 'x may depend only on the listed components — any other outgoing dependency from x is a violation.',
    producesRuleKind: ['arch.layers'],
  },
  'arch.layer(x).cannotDependOn(...refs)': {
    description: 'x must not depend on any of the listed components — one arch.no-dependency rule per listed component.',
    producesRuleKind: ['arch.no-dependency'],
  },
  'arch.component(x).isIsolated()': {
    description: 'no other component may depend on x, and x depends on none of them — a no-dependency rule pair for every other component.',
    producesRuleKind: ['arch.no-dependency'],
  },
  'arch.component(x).maxLinesPerFile(max)': {
    description: 'every file classified into x must stay at or under max lines (metric: loc — the only promoted arch.metric metric today).',
    producesRuleKind: ['arch.metric'],
  },
  'arch.noCycles(scope?, options?)': {
    description: "no import cycles within scope (defaults to the whole repo). options.includeTypeOnly widens cycle detection to type-only edges (excluded by default).",
    producesRuleKind: ['arch.no-cycles'],
  },
  'custom.host(hostRuleName)': {
    description:
      'references a HostPredicate registered under the same name in align.config.ts\'s sibling `hostRules` export ' +
      '(`Record<string, HostPredicate>`). Registration is required: an unregistered hostRuleName hard-errors the ' +
      'gate at check time (never silently reports green) — register the predicate, fix the typo, or remove the rule.',
    producesRuleKind: ['custom.host'],
  },
  'security.manifest.sourceHygiene()': {
    description: 'any dependency specifier resolving to a git/http(s)/file/link source (not registry, not workspace:) is a violation. Takes no arguments — the manifest scan domain has no notion of file-classified components.',
    producesRuleKind: ['security.manifest.source-hygiene'],
  },
  'security.manifest.newDependencyGate()': {
    description: 'every current runtime/dev dependency is fingerprinted at baseline time; only a genuinely new dependency added afterward shows red. Takes no arguments.',
    producesRuleKind: ['security.manifest.new-dependency'],
  },
};

const DUMMY_TOKEN: ComponentToken = { name: toComponentName('x') };

/** Runtime-introspects the real builder objects `factories.ts` constructs — the "live registry"
 * `align skill` reads instead of a hand-typed verb list. */
function introspectVerbPaths(): readonly string[] {
  const paths: string[] = [];

  const arch = makeArchFactory([DUMMY_TOKEN]);
  const layerBuilder = arch.layer(DUMMY_TOKEN);
  for (const key of Object.keys(layerBuilder)) paths.push(`arch.layer(x).${key}(...refs)`);
  const componentBuilder = arch.component(DUMMY_TOKEN);
  for (const key of Object.keys(componentBuilder)) {
    paths.push(key === 'maxLinesPerFile' ? `arch.component(x).${key}(max)` : `arch.component(x).${key}()`);
  }
  paths.push('arch.noCycles(scope?, options?)');

  const custom = makeCustomFactory();
  for (const key of Object.keys(custom)) paths.push(`custom.${key}(hostRuleName)`);

  const security = makeSecurityFactory();
  for (const key of Object.keys(security.manifest)) paths.push(`security.manifest.${key}()`);

  return paths;
}

/** Fails fast (throws) if the live builder surface and `VERB_DESCRIPTIONS` have diverged in
 * either direction — a verb introspected but undocumented, or a documented verb that no longer
 * exists. Both are the same class of bug the plan's false-green invariant suite watches for
 * elsewhere: a skill that silently stops describing reality. */
export function describeDslVerbs(): readonly DslVerbEntry[] {
  const introspected = introspectVerbPaths();
  const introspectedSet = new Set(introspected);
  const documentedSet = new Set(Object.keys(VERB_DESCRIPTIONS));

  const undocumented = introspected.filter((p) => !documentedSet.has(p));
  if (undocumented.length > 0) {
    throw new Error(
      `dsl/verb-manifest.ts: the following DSL verb(s) are introspected from the live builder ` +
        `surface but have no entry in VERB_DESCRIPTIONS: ${undocumented.join(', ')}. Add a ` +
        `description so \`align skill\` cannot silently drift from the installed DSL.`,
    );
  }
  const stale = [...documentedSet].filter((p) => !introspectedSet.has(p));
  if (stale.length > 0) {
    throw new Error(
      `dsl/verb-manifest.ts: VERB_DESCRIPTIONS documents verb(s) that no longer exist on the ` +
        `live builder surface: ${stale.join(', ')}. Remove the stale entry (or the verb was ` +
        `renamed — update the path to match).`,
    );
  }

  return introspected.map((path) => ({ path, ...VERB_DESCRIPTIONS[path]! }));
}
