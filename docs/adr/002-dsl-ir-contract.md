# ADR 002: DSL → IR Contract

**Status**: Accepted

## Context

align's authoring surface (`align.config.ts`) must be a typed, autocompleting SDK — not a stringly-typed
config format — while its execution substrate (the IR) must be portable JSON that a rule evaluator, a cache
key, and a baseline fingerprint can all consume without importing TypeScript. These are different jobs and
the DSL/IR split exists to keep them from contaminating each other (locked decision #1 in the plan). The
contract between them — what the DSL compiles to, what's allowed to vary, what's version-locked — has to be
fixed before Stage 1 writes a line of DSL code, because every later stage (rules-build, MCP rule proposals,
baseline fingerprints) programs against the IR, not the DSL surface.

## Decision

**Typed authoring surface**:
```ts
export default defineProject({
  components: { api: 'package:@kluster/api', core: 'packages/core/*' },
  rules: (c) => [
    c.arch.layer(c.api).canOnlyDependOn(c.core),
    c.arch.component(c.core).isIsolated(),
  ],
});
```
- `defineProject<T extends Record<string, string>>({ components, rules?: (c: ComponentContext<T>) =>
  RuleIR[] })`. `ComponentContext<T>` is generically typed from the component keys — `c.api` autocompletes,
  and renaming a component key turns every rule referencing it into a compile error (not a silent no-op).
- **Reserved-name type guards**: component keys colliding with reserved factory names (`arch`, `metrics`,
  `gates`, `security`, `custom`) are **compile errors**, enforced at the type level (a conditional type that
  resolves to `never`/an error-message literal on collision), so a token can never shadow a factory.
- `rules` is optional — `defineProject({ components })` alone is valid; zero-DSL day-one value (tool gates,
  Stage 1+) is unaffected by whether an architecture ruleset exists yet.

**Negation-free vocabulary** — positive, asymmetric verbs only, no double-negative chains:

| Verb | Meaning |
|---|---|
| `isIsolated()` | no other component may depend on this one, and it depends on none |
| `canOnlyDependOn(...refs)` | dependencies outside this allowlist are violations |
| `cannotDependOn(...refs)` | dependencies on this denylist are violations; everything else is permitted |
| `maxLinesPerFile(max)` | every file in this component must stay at or under `max` lines |

No `.not()`, no `.doesNotDependOn().unless()`. A rule reads as one sentence with one polarity.

**Promotion note (2026-07-12, user-approved)**: `maxLinesPerFile(max)` is the DSL surface for
`arch.metric` (max-LOC only), promoted from Design Reserve on kluster ruleset evidence — two
2,100+-line files structurally invisible to every dependency/cycle verb in this table
(`test-apps/kluster/RULESET_REPORT.md` §6.2, `IMPLEMENTATION_PLAN.md`'s Promotion log). It's the one
verb in this table that isn't dependency-direction-shaped; it was added under `c.arch.component(x)`
(alongside `isIsolated()`) rather than a new top-level factory, since `arch.metric`'s reserved
sibling metrics (`fan-in`/`fan-out`/`instability`) stay unexercised and a `c.metrics` factory would
be premature until at least one of them is promoted too.

**`.because(text)` hoisting**: `.because('The API must remain headless.')` attaches to the `RuleIR` node as
`provenance.because` (see `docs/ir-schema.md`) and is the single field feeding: terminal violation output,
IDE hover (via JSDoc, no editor extension needed), `ruleExplanations` in future fix prompts, and (for
doc-built rules, ADR 011) auto-population from `sourceQuote`. One field, four consumers — never duplicated
per consumer.

**IR contract**:
- The IR is a **discriminated union** (`RuleIR`, tagged by `kind`), validated with **zod**, carrying
  **`irVersion: '1'`** at the ruleset root. A rule evaluator switches exhaustively on `kind`; adding a rule
  kind without updating every evaluator is a compile error (`never`-check per
  `CODING_BEST_PRACTICES.md` §17.2).
- **Portability discipline, not a straitjacket**: "portability never vetoes a TS-plugin feature." Rule kinds
  that are inherently non-portable (compiler-specific analyses) are first-class and explicitly flagged via a
  reserved `ts.*` namespace and a `portable: false` marker — not smuggled through a generic escape hatch and
  not shamed out of the DSL.
- **`custom.host` escape hatch**: a rule kind for host-defined logic align's IR doesn't model yet
  (`{ kind: 'custom.host', hostRuleName: string, portable: false, ... }`, see `docs/ir-schema.md`). It exists
  so a real, encountered need doesn't force a schema migration before it can be expressed once.

## Alternatives considered

- **No generic `ComponentContext`, plain string component names** (`c('api').canOnlyDependOn('core')`).
  Rejected: no compile-time rename safety — the exact selector-drift risk ADR 003 exists to prevent at the
  registry level would resurface at the call-site level.
- **Negation-permitting vocabulary** (`isNot`, `doesNotAllow`). Rejected per the plan's named design
  principle — double-negative rule reading is a proven source of authored-rule bugs in other DSLs (ArchUnit
  issues cited in prior design rounds) and the fluent surface is precisely where readability has to win.
- **IR as generated TypeScript instead of JSON.** Rejected — locked decision #1: JSON IR is the cache-hash
  substrate, the explain-rule payload, and the baseline contract regardless of plugin count; generated TS
  would require a TS parser wherever the IR is consumed (cache key, CLI, MCP), defeating portability.

## Consequences

- Every rule kind added to the IR must be added to the exhaustive evaluator switch — enforced by the
  compiler, not a lint rule, per the discriminated-union technique.
- `.because()` is the only provenance-carrying field in the DSL layer; ADR 011's `sourceFile`/
  `sourceLineRange`/`sourceQuote` extend `RuleProvenance` at the IR level without touching the DSL surface.
- `irVersion` gives Stage 5's IR-migration machinery a version to branch on without touching v1 rule kinds.

## Evidence

- No direct spike measurement of the DSL surface (spike used hardcoded rules, not the DSL) — this ADR
  encodes the plan's locked decisions and `CODING_BEST_PRACTICES.md` §9–13 (discriminated unions, `type` vs
  `interface`, generics with genuine reuse). The IR's *portability discipline* is validated indirectly: the
  spike never needed a non-portable rule kind, so `ts.*`/`custom.host` remain a designed-but-unexercised
  escape hatch (Design Reserve posture for actual usage, not for the schema slot).
