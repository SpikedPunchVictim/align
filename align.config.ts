import { defineProject, external } from '@spikedpunch/align-core/dsl';
import { toRepoRelativePath, type HostPredicate, type HostRuleContext, type HostViolation, type RepoRelativePath } from '@spikedpunch/align-core';

// align dogfoods itself (IMPLEMENTATION_PLAN.md Stage 1 success criteria): core never imports
// plugin-typescript or cli, and the whole repo stays cycle-free. Hand-refined from `align init`'s
// generic single-bucket starter (which only saw one pnpm-workspace.yaml pattern, `packages/*`,
// and so proposed one component covering all three packages) into per-package components that
// can actually express the composition-root direction ARCHITECTURE.md §5 requires.
// Scan-time excludes (not part of the portable IR — see packages/cli/src/config.ts's documented
// deviation): test-apps/ is a read-only external target and docs/evidence/ holds the relocated
// throwaway spike and probe code (see docs/evidence/*) — neither is part of align's own architecture; fixture trees under packages/*/test/fixtures/ intentionally
// contain seeded violations (cycles, forbidden imports) and must not leak into the dogfood check.
export const excludes = [
  'test-apps',
  'docs/evidence',
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
// `no-child-process-outside-git-rails` dogfood — PARTIALLY migrated to a portable `external()` rule
// (ADR 017 Part A, 2026-07-21). The original predicate banned `node:child_process` repo-wide except
// for an explicit rails allowlist + a test-file exemption; `core`/`pluginTypescript`/`cli` have ZERO
// legitimate need for it (verified against the real import graph — neither production nor test code
// in those three packages imports it) and no file-level exemption to express, so those three now
// carry a fully portable `cannotDependOn(external('node:child_process'))` rule below instead
// (survives `align check --untrusted`, unlike this predicate). This predicate is KEPT, narrowed to
// `agent`/`createAlign` only: the file-level rails allowlist (specific files within a component may
// import it, others in the same component may not) and the test-directory exemption are both
// sub-component-granularity concerns `arch.no-dependency`/`arch.layers` cannot express at
// whole-component grain (the same gap `typesLayerIsLeaf` below documents, ADR 017's own §A.2.2
// callout) — genuinely out of Part A's scope, not a shortcut. Restructuring align's own component
// map to carve out file-level sub-components was considered and rejected: it would reclassify real
// files used by OTHER rules in this ruleset (`agent`/`createAlign`'s `canOnlyDependOn`/`isIsolated`),
// widening blast radius for a single-rule simplification — not worth it for three files.
//
// Scoped to what's actually true, verified against the real import graph before writing this rule
// (not assumed from the task brief, which proposed "git.ts + the CLI composition root"). The
// PRODUCTION-code importers are exactly two — `packages/agent/src/git.ts` (git/gh shell-out,
// execFile-only, no shell string) and `packages/agent/src/format.ts` (mechanical prettier
// invocation against the TARGET repo being fixed, same execFile discipline); the CLI composition
// root has zero `child_process` importers today, so the brief's assumed scope was corrected to
// match reality. The first real run of this predicate also found one TEST-time importer —
// `packages/agent/test/e2e-git.test.ts` (spawns real git for E2E verification) — a legitimate,
// reviewed shell-out that exists only at test time and is never shipped. Rather than hardcode an
// ever-growing per-file allowlist for future e2e tests, the predicate exempts test files by path
// convention (`**/test/**`, this repo's one test-directory convention, confirmed against every
// package) — the rule's actual concern is the PRODUCTION shell-out surface.
//
// `packages/create-align/src/nodeEffects.ts` joined this allowlist when `@spikedpunch/create-align`
// shipped (`pnpm create @spikedpunch/align`): it's the one file that shells out to the target
// repo's package manager (`pnpm add -D`/`npm i -D`/`yarn add -D`) and to the freshly-installed
// local `align` binary (`align init`) — the same execFile-only, argv-array discipline as
// align-agent's git rails, isolated to a single file for the same reason.
const CHILD_PROCESS_ALLOWED_FILES: ReadonlySet<RepoRelativePath> = new Set([
  toRepoRelativePath('packages/agent/src/git.ts'),
  toRepoRelativePath('packages/agent/src/format.ts'),
  toRepoRelativePath('packages/create-align/src/nodeEffects.ts'),
]);

function isTestFile(file: RepoRelativePath): boolean {
  return file.split('/').includes('test');
}

// Narrowed to `agent`/`createAlign` (ADR 017 Part A migration, 2026-07-21, see the doc comment
// above): `core`/`pluginTypescript`/`cli` are now covered by a portable
// `cannotDependOn(external('node:child_process'))` rule below instead — this predicate only still
// needs to reason about the two components with a genuine file-level exemption.
const CHILD_PROCESS_SCOPED_COMPONENTS: ReadonlySet<string> = new Set(['agent', 'createAlign']);

export const hostRules: Record<string, HostPredicate> = {
  'no-child-process-outside-git-rails': (ctx: HostRuleContext): HostViolation[] => {
    const violations: HostViolation[] = [];
    for (const edge of ctx.graph.externalEdges) {
      if (edge.to !== 'external:node:child_process') continue;
      const component = ctx.componentOf(edge.from);
      if (component === undefined || !CHILD_PROCESS_SCOPED_COMPONENTS.has(component)) continue;
      if (CHILD_PROCESS_ALLOWED_FILES.has(edge.from)) continue;
      if (isTestFile(edge.from)) continue;
      violations.push({
        file: edge.from,
        range: { startLine: edge.line, endLine: edge.line },
        snippet: edge.snippet,
        message:
          `Only align's audited execFile-only rails (${[...CHILD_PROCESS_ALLOWED_FILES].join(', ')}) ` +
          `may import node:child_process outside test files — '${edge.from}' imports it via '${edge.specifier}'.`,
      });
    }
    return violations;
  },
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
    createAlign: 'packages/create-align/**',
  },
  rules: (c) => [
    c.arch.noCycles(),
    c.arch
      .layer(c.core)
      .cannotDependOn(c.pluginTypescript, c.cli, c.agent, external('node:child_process'))
      .because('@spikedpunch/align-core has zero framework dependencies (zod only) so it stays importable by a future non-Node/non-TS consumer without dragging a compiler along — plugin-typescript, cli, and agent implement its interfaces, never the reverse (ARCHITECTURE.md §5). The node:child_process arm is ADR 017 Part A\'s dogfood migration: core has no legitimate shell-out need, so this is a fully portable replacement for the corresponding slice of the no-child-process-outside-git-rails custom.host predicate below (survives `align check --untrusted`, unlike that predicate).'),
    c.arch
      .layer(c.pluginTypescript)
      .cannotDependOn(external('node:child_process'))
      .because('ADR 017 Part A dogfood migration: plugin-typescript (the TS scanner) has no legitimate child_process need — a portable replacement for the corresponding slice of no-child-process-outside-git-rails.'),
    c.arch
      .layer(c.cli)
      .canOnlyDependOn(c.core, c.pluginTypescript, c.agent)
      .because('cli is the composition root — the only package that imports a concrete LanguagePlugin/FixProvider and wires it together (ARCHITECTURE.md §5).'),
    c.arch
      .layer(c.cli)
      .cannotDependOn(external('node:child_process'))
      .because('ADR 017 Part A dogfood migration: the CLI composition root has zero legitimate child_process need today — a portable replacement for the corresponding slice of no-child-process-outside-git-rails.'),
    c.arch
      .layer(c.agent)
      .canOnlyDependOn(c.core)
      .because('@spikedpunch/align-agent (Stage 4 BYOK fix loop, ADR 010) depends only on @spikedpunch/align-core + @anthropic-ai/sdk — it never imports plugin-typescript or cli; the CLI composition root wires concrete effects (git, fs, the TS scanner) into it, not the reverse (IMPLEMENTATION_PLAN.md Stage 4).'),
    c.arch
      .component(c.createAlign)
      .isIsolated()
      .because('@spikedpunch/create-align (`pnpm create @spikedpunch/align`) bootstraps align into a target repo by shelling out to the package manager and the freshly-installed align binary — it imports nothing from core/plugin-typescript/cli/agent, and nothing in this repo imports it back, a true leaf package (rule of three: install logic lives only here, scaffolding logic only in cli/init).'),
    c.custom
      .host('typesLayerIsLeaf')
      .because("packages/core/src/types/ is align's foundation layer (branded types, IR zod schema, Violation model) and must not acquire a dependency on any sibling subdirectory of packages/core/src/ — a sub-path-scoped invariant arch.layers/arch.no-dependency can't express at core's whole-component granularity (docs/proposals/rule-expansion-evaluation.md §A.2.2). Predicate registered in this file's hostRules export."),
    c.custom
      .host('no-child-process-outside-git-rails')
      .because('node:child_process shell-outs in agent/createAlign PRODUCTION code must stay confined to the audited, execFile-only rails (packages/agent/src/git.ts, packages/agent/src/format.ts, packages/create-align/src/nodeEffects.ts) — everywhere else in those two components, a child_process import is an unaudited shell-injection/supply-chain surface (test files are exempt; e2e-git.test.ts has a legitimate, reviewed test-time shell-out). core/pluginTypescript/cli are now covered by the three portable cannotDependOn(external(\'node:child_process\')) rules above instead (ADR 017 Part A, 2026-07-21 migration) — this predicate is narrowed to the two components with a genuine file-level exemption arch.no-dependency/arch.layers cannot express at whole-component grain (docs/proposals/rule-expansion-evaluation.md §A.2.2, same gap typesLayerIsLeaf documents). Predicate registered in this file\'s hostRules export.'),
    // security.manifest gate dogfood (ADR 013, promoted 2026-07-12 on docs/evidence/manifest-security-probe/MANIFEST_PROBE_REPORT.md
    // probe evidence): align adopts its own two rules. `newDependencyGate` fingerprints every
    // current runtime/dev dependency across root + every workspace member's package.json —
    // `align init`/`baseline accept` seeds today's set once, so only a genuinely new dependency
    // (e.g. the probe's own real-world catch, `@anthropic-ai/sdk` entering `packages/agent` in
    // Stage 4) shows red going forward. `sourceHygiene` has zero pre-existing findings on align
    // itself (probe-measured) — align's own deps are all registry/workspace-protocol.
    c.security.manifest
      .sourceHygiene()
      .because('Non-registry dependency sources need explicit human sign-off before they enter the tree (docs/evidence/manifest-security-probe/MANIFEST_PROBE_REPORT.md Rule 1).'),
    c.security.manifest
      .newDependencyGate()
      .because('A newly added dependency is a genuinely new, externally-sourced surface worth a deliberate look before it merges (docs/evidence/manifest-security-probe/MANIFEST_PROBE_REPORT.md Rule 7 — real historical catch: @anthropic-ai/sdk entering this repo in Stage 4).'),
  ],
});

// align:generated-rules-note:start
// `.align/generated-rules.json` (written by `align build --apply`, ADR 011) is merged into
// this ruleset automatically at load time (`mergeGeneratedRules`) — you never need to import
// it here. Run `align explain <ruleId>` to see a rule's provenance (hand-authored vs.
// doc-built).
// align:generated-rules-note:end
