import { defineProject } from '@align/core/dsl';

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
  ],
});

// align:generated-rules-note:start
// `.align/generated-rules.json` (written by `align build --apply`, ADR 011) is merged into
// this ruleset automatically at load time (`mergeGeneratedRules`) — you never need to import
// it here. Run `align explain <ruleId>` to see a rule's provenance (hand-authored vs.
// doc-built).
// align:generated-rules-note:end
