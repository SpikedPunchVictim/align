import { defineProject } from '@align/core/dsl';
import type { HostPredicate, HostRuleContext, HostViolation } from '@align/core';

// align dogfoods itself (IMPLEMENTATION_PLAN.md Stage 1 success criteria): core never imports
// plugin-typescript or cli, and the whole repo stays cycle-free. Hand-refined from `align init`'s
// generic single-bucket starter (which only saw one pnpm-workspace.yaml pattern, `packages/*`,
// and so proposed one component covering all three packages) into per-package components that
// can actually express the composition-root direction ARCHITECTURE.md §5 requires.
// Scan-time excludes (not part of the portable IR — see packages/cli/src/config.ts's documented
// deviation): test-apps/ and spike/ are read-only external targets and throwaway spike code, not
// part of align's own architecture; fixture trees under packages/*/test/fixtures/ intentionally
// contain seeded violations (cycles, forbidden imports) and must not leak into the dogfood check.
export const excludes = [
  'test-apps',
  'spike',
  'packages/core/test/fixtures',
  'packages/plugin-typescript/test/fixtures',
  'packages/cli/test/fixtures',
  'packages/agent/test/fixtures',
];

// `custom.host` dogfood (docs/proposals/rule-expansion-evaluation.md §B.0, registration surface
// promoted 2026-07-12): one real predicate, registered here and referenced by
// `c.custom.host('typesLayerIsLeaf')` below, to exercise the mechanism end-to-end on align's own
// repo rather than a synthetic fixture.
//
// Scoped to a genuine, evidence-backed sub-path invariant `arch.*` cannot express today (the
// evaluation doc's §A.2.2 "component sub-path scoping gap" — `arch.layers`/`arch.no-dependency`
// only see whole-component granularity, and `core` is one component covering all of
// `packages/core/**`): `packages/core/src/types/` is align's foundation layer (branded types, the
// IR zod schema, the Violation model — CODING_BEST_PRACTICES.md §1's "the types are the design")
// and, verified against the live import graph before writing this rule, currently imports nothing
// from any sibling subdirectory of `packages/core/src/`. That's a real, already-true invariant
// worth protecting from regression, not a fabricated violation to manufacture a "finding."
//
// (The originally-considered `no-child-process-outside-git-rails` rule turned out to be
// inexpressible with today's `DependencyGraph`: the scanner classifies every `node:*`/builtin
// specifier as `external` and discards it before an edge is ever recorded
// (`packages/plugin-typescript/src/tsconfig-resolver.ts:30`), so a predicate operating on
// `ctx.graph` alone has zero visibility into `child_process` imports — independently confirming
// the evaluation doc's own top-of-document correction #2 from the predicate-authoring side.)
export const hostRules: Record<string, HostPredicate> = {
  typesLayerIsLeaf: (ctx: HostRuleContext): HostViolation[] => {
    const violations: HostViolation[] = [];
    for (const edge of ctx.graph.edges) {
      if (!edge.from.startsWith('packages/core/src/types/')) continue;
      if (edge.to.startsWith('packages/core/src/types/')) continue; // intra-types imports are fine
      if (!edge.to.startsWith('packages/core/src/')) continue; // only within-core edges are in scope
      violations.push({
        file: edge.from,
        range: { startLine: edge.line, endLine: edge.line },
        snippet: edge.snippet,
        message:
          `packages/core/src/types/ is align's foundation layer and must not depend on any sibling ` +
          `subdirectory of packages/core/src/ — '${edge.from}' imports '${edge.to}' via '${edge.specifier}'.`,
      });
    }
    return violations;
  },
};

export default defineProject({
  components: {
    core: 'packages/core/**',
    pluginTypescript: 'packages/plugin-typescript/**',
    cli: 'packages/cli/**',
    agent: 'packages/agent/**',
  },
  rules: (c) => [
    c.arch.noCycles(),
    c.arch
      .layer(c.core)
      .cannotDependOn(c.pluginTypescript, c.cli, c.agent)
      .because('@align/core has zero framework dependencies (zod only) so it stays importable by a future non-Node/non-TS consumer without dragging a compiler along — plugin-typescript, cli, and agent implement its interfaces, never the reverse (ARCHITECTURE.md §5).'),
    c.arch
      .layer(c.cli)
      .canOnlyDependOn(c.core, c.pluginTypescript, c.agent)
      .because('cli is the composition root — the only package that imports a concrete LanguagePlugin/FixProvider and wires it together (ARCHITECTURE.md §5).'),
    c.arch
      .layer(c.agent)
      .canOnlyDependOn(c.core)
      .because('@align/agent (Stage 4 BYOK fix loop, ADR 010) depends only on @align/core + @anthropic-ai/sdk — it never imports plugin-typescript or cli; the CLI composition root wires concrete effects (git, fs, the TS scanner) into it, not the reverse (IMPLEMENTATION_PLAN.md Stage 4).'),
    c.custom
      .host('typesLayerIsLeaf')
      .because("packages/core/src/types/ is align's foundation layer (branded types, IR zod schema, Violation model) and must not acquire a dependency on any sibling subdirectory of packages/core/src/ — a sub-path-scoped invariant arch.layers/arch.no-dependency can't express at core's whole-component granularity (docs/proposals/rule-expansion-evaluation.md §A.2.2). Predicate registered in this file's hostRules export."),
    // security.manifest gate dogfood (ADR 013, promoted 2026-07-12 on spike/MANIFEST_PROBE_REPORT.md
    // probe evidence): align adopts its own two rules. `newDependencyGate` fingerprints every
    // current runtime/dev dependency across root + every workspace member's package.json —
    // `align init`/`baseline accept` seeds today's set once, so only a genuinely new dependency
    // (e.g. the probe's own real-world catch, `@anthropic-ai/sdk` entering `packages/agent` in
    // Stage 4) shows red going forward. `sourceHygiene` has zero pre-existing findings on align
    // itself (probe-measured) — align's own deps are all registry/workspace-protocol.
    c.security.manifest
      .sourceHygiene()
      .because('Non-registry dependency sources need explicit human sign-off before they enter the tree (spike/MANIFEST_PROBE_REPORT.md Rule 1).'),
    c.security.manifest
      .newDependencyGate()
      .because('A newly added dependency is a genuinely new, externally-sourced surface worth a deliberate look before it merges (spike/MANIFEST_PROBE_REPORT.md Rule 7 — real historical catch: @anthropic-ai/sdk entering this repo in Stage 4).'),
  ],
});

// align:generated-rules-note:start
// `.align/generated-rules.json` (written by `align build --apply`, ADR 011) is merged into
// this ruleset automatically at load time (`mergeGeneratedRules`) — you never need to import
// it here. Run `align explain <ruleId>` to see a rule's provenance (hand-authored vs.
// doc-built).
// align:generated-rules-note:end
