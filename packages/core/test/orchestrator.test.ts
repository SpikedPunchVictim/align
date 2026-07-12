import { describe, expect, it } from 'vitest';
import { GateOrchestrator } from '../src/orchestrator.js';
import { InMemoryBaselineStore } from '../src/baseline/store.js';
import { StaticPluginRegistry, type LanguagePlugin } from '../src/plugin/registry.js';
import { defineProject } from '../src/dsl/index.js';
import type { HostPredicate } from '../src/rules/host-rules.js';
import { edge, graph, node } from './helpers.js';
import type { ScanInput } from '../src/scanner.js';
import { toRepoRelativePath } from '../src/types/branded.js';
import type { ManifestInventory, ManifestScanner } from '../src/types/manifest.js';

function fakePlugin(build: (input: ScanInput) => ReturnType<typeof graph>): LanguagePlugin {
  return {
    id: 'fake',
    fileMatch: ['**/*.ts'],
    scanner: { scan: async (input: ScanInput) => build(input) },
  };
}

function fakeManifestScanner(inventory: ManifestInventory): ManifestScanner {
  return { scan: () => inventory };
}

describe('GateOrchestrator', () => {
  it('is green when the scan produces no violations', async () => {
    const ruleset = defineProject({
      components: { api: 'application/api/**', ui: 'application/ui/**' },
      rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],
    });
    const registry = new StaticPluginRegistry([
      fakePlugin(() => graph([node('application/api/a.ts', 'api'), node('application/ui/b.ts', 'ui')], [])),
    ]);
    const orchestrator = new GateOrchestrator(registry, ruleset, new InMemoryBaselineStore());
    const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
    expect(run.verdict).toBe('green');
    expect(run.gates.map((g) => g.gate)).toEqual(['parse', 'architecture', 'security']);
  });

  it('is red when a forbidden edge is present', async () => {
    const ruleset = defineProject({
      components: { api: 'application/api/**', ui: 'application/ui/**' },
      rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],
    });
    const registry = new StaticPluginRegistry([
      fakePlugin(() =>
        graph(
          [node('application/api/a.ts', 'api'), node('application/ui/b.ts', 'ui')],
          [edge('application/api/a.ts', 'application/ui/b.ts', { specifier: '../ui/b', line: 3 })],
        ),
      ),
    ]);
    const orchestrator = new GateOrchestrator(registry, ruleset, new InMemoryBaselineStore());
    const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
    expect(run.verdict).toBe('red');
    const archGate = run.gates.find((g) => g.gate === 'architecture');
    expect(archGate?.violations).toHaveLength(1);
  });

  it('baselined violations count toward baselinedCount, not red', async () => {
    const ruleset = defineProject({
      components: { api: 'application/api/**', ui: 'application/ui/**' },
      rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],
    });
    const scanGraph = graph(
      [node('application/api/a.ts', 'api'), node('application/ui/b.ts', 'ui')],
      [edge('application/api/a.ts', 'application/ui/b.ts', { specifier: '../ui/b', line: 3 })],
    );
    const registry = new StaticPluginRegistry([fakePlugin(() => scanGraph)]);
    const baseline = new InMemoryBaselineStore();
    // seed baseline by evaluating once, out of band, then accepting
    const seedOrchestrator = new GateOrchestrator(registry, ruleset, baseline);
    const seedRun = await seedOrchestrator.check({ rootDir: '/repo', excludes: [] });
    const archGate = seedRun.gates.find((g) => g.gate === 'architecture');
    baseline.accept(archGate?.violations ?? [], 'init-seed');

    const run = await seedOrchestrator.check({ rootDir: '/repo', excludes: [] });
    expect(run.verdict).toBe('green');
    const gate = run.gates.find((g) => g.gate === 'architecture');
    expect(gate?.baselinedCount).toBe(1);
    expect(gate?.violations).toHaveLength(0);
  });

  it('reports gate error and skips architecture when the scan throws (environmental failure, ADR 008)', async () => {
    const ruleset = defineProject({ components: { api: 'application/api/**' } });
    const registry = new StaticPluginRegistry([
      fakePlugin(() => {
        throw new Error('scanner crashed');
      }),
    ]);
    const orchestrator = new GateOrchestrator(registry, ruleset, new InMemoryBaselineStore());
    const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
    expect(run.verdict).toBe('error');
    const parseGate = run.gates.find((g) => g.gate === 'parse');
    expect(parseGate?.status).toBe('error');
    const archGate = run.gates.find((g) => g.gate === 'architecture');
    expect(archGate?.status).toBe('skipped');
  });

  it('reports architecture gate error (never green) when a rule references an unknown component (false-green guard)', async () => {
    const ruleset = defineProject({
      components: { api: 'application/api/**', ui: 'application/ui/**' },
      rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],
    });
    // Simulate a stale `.align/generated-rules.json` (or a hand-edited RulesetIR) still naming a
    // component that has since been renamed/removed from `align.config.ts`'s components map —
    // `mergeGeneratedRules` would happily splice this in without complaint, since it only checks
    // id collisions, not ComponentRef validity.
    const staleRuleset = {
      ...ruleset,
      rules: [...ruleset.rules, { kind: 'arch.no-dependency', id: 'stale-rule', from: 'ghost', to: 'ui', provenance: {} }],
    } as typeof ruleset;
    const registry = new StaticPluginRegistry([
      fakePlugin(() => graph([node('application/api/a.ts', 'api'), node('application/ui/b.ts', 'ui')], [])),
    ]);
    const orchestrator = new GateOrchestrator(registry, staleRuleset, new InMemoryBaselineStore());
    const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
    expect(run.verdict).toBe('error');
    const archGate = run.gates.find((g) => g.gate === 'architecture');
    expect(archGate?.status).toBe('error');
    expect(archGate?.errorMessage).toContain('stale-rule');
    expect(archGate?.errorMessage).toContain('ghost');
  });

  it('reports architecture gate error (never green) when a custom.host rule names an unregistered predicate (false-green guard)', async () => {
    const ruleset = defineProject({
      components: { api: 'application/api/**' },
    });
    // `evaluateRule` returns zero violations for `custom.host` (v1 has no host-rule execution
    // mechanism), so without this guard the rule would count as passing while enforcing nothing.
    // Only reachable via generated-rules merge or a hand-edited RulesetIR — the DSL has no
    // custom.host verb — same injection shape as the stale ComponentRef test above.
    const hostRuleset = {
      ...ruleset,
      rules: [...ruleset.rules, { kind: 'custom.host', id: 'custom.host:route-thinness', hostRuleName: 'route-thinness', portable: false, provenance: {} }],
    } as typeof ruleset;
    const registry = new StaticPluginRegistry([
      fakePlugin(() => graph([node('application/api/a.ts', 'api')], [])),
    ]);
    const orchestrator = new GateOrchestrator(registry, hostRuleset, new InMemoryBaselineStore());
    const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
    expect(run.verdict).toBe('error');
    const archGate = run.gates.find((g) => g.gate === 'architecture');
    expect(archGate?.status).toBe('error');
    expect(archGate?.errorMessage).toContain('custom.host:route-thinness');
    expect(archGate?.errorMessage).toContain("'route-thinness'");
  });

  it('reports architecture gate error (never green) when a declared component has zero classified files (ADR 003, false-green guard)', async () => {
    const ruleset = defineProject({
      components: { api: 'application/api/**', ui: 'application/ui/**' },
      rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],
    });
    const registry = new StaticPluginRegistry([
      // `ui` is a declared, valid component name, but nothing in this scan classifies as `ui` —
      // its rules would evaluate vacuously green. This is the orchestrator-level,
      // plugin-independent half of ADR 003's empty-selector-fails-by-default doctrine (the
      // TypeScript scanner separately enforces the selector-based half via `validateComponents`);
      // it also covers a component fully shadowed by an earlier first-match-wins selector, which
      // selector-based validation cannot see.
      fakePlugin(() => graph([node('application/api/a.ts', 'api')], [])),
    ]);
    const orchestrator = new GateOrchestrator(registry, ruleset, new InMemoryBaselineStore());
    const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
    expect(run.verdict).toBe('error');
    const archGate = run.gates.find((g) => g.gate === 'architecture');
    expect(archGate?.status).toBe('error');
    expect(archGate?.errorMessage).toContain("'ui'");
    expect(archGate?.errorMessage).toContain('application/ui/**');
    expect(archGate?.errorMessage).toContain('allowEmpty');
  });

  it('a zero-classified-files component with allowEmpty: true stays green (ADR 003 opt-out)', async () => {
    const ruleset = defineProject({
      components: { api: 'application/api/**', ui: { pattern: 'application/ui/**', allowEmpty: true } },
      rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],
    });
    const registry = new StaticPluginRegistry([
      fakePlugin(() => graph([node('application/api/a.ts', 'api')], [])),
    ]);
    const orchestrator = new GateOrchestrator(registry, ruleset, new InMemoryBaselineStore());
    const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
    expect(run.verdict).toBe('green');
  });

  it('freshness: a fresh scan reflects a fix with no restart required (ADR 005)', async () => {
    const ruleset = defineProject({
      components: { api: 'application/api/**', ui: 'application/ui/**' },
      rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],
    });
    let hasViolation = true;
    const registry = new StaticPluginRegistry([
      fakePlugin(() =>
        hasViolation
          ? graph(
              [node('application/api/a.ts', 'api'), node('application/ui/b.ts', 'ui')],
              [edge('application/api/a.ts', 'application/ui/b.ts', { specifier: '../ui/b', line: 3 })],
            )
          : graph([node('application/api/a.ts', 'api'), node('application/ui/b.ts', 'ui')], []),
      ),
    ]);
    const orchestrator = new GateOrchestrator(registry, ruleset, new InMemoryBaselineStore());
    const redRun = await orchestrator.check({ rootDir: '/repo', excludes: [] });
    expect(redRun.verdict).toBe('red');

    hasViolation = false; // the "fix"
    const greenRun = await orchestrator.check({ rootDir: '/repo', excludes: [] });
    expect(greenRun.verdict).toBe('green');
  });

  it('move-transfer (ADR 006): renaming a baselined violation\'s file stays green and reports the transfer', async () => {
    const ruleset = defineProject({
      components: { api: 'application/api/**', ui: 'application/ui/**' },
      rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],
    });
    let fromFile = 'application/api/a.ts';
    const registry = new StaticPluginRegistry([
      fakePlugin(() =>
        graph(
          [node(fromFile, 'api'), node('application/ui/b.ts', 'ui')],
          [edge(fromFile, 'application/ui/b.ts', { specifier: '../ui/b', line: 3 })],
        ),
      ),
    ]);
    const baseline = new InMemoryBaselineStore();
    const orchestrator = new GateOrchestrator(registry, ruleset, baseline);

    const seedRun = await orchestrator.check({ rootDir: '/repo', excludes: [] });
    const archGate = seedRun.gates.find((g) => g.gate === 'architecture');
    baseline.accept(archGate?.violations ?? [], 'init-seed');
    expect((await orchestrator.check({ rootDir: '/repo', excludes: [] })).verdict).toBe('green');

    // Rename the offending file — same snippet/specifier, new structural fingerprint.
    fromFile = 'application/api/renamed.ts';
    const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
    expect(run.verdict).toBe('green');
    const gate = run.gates.find((g) => g.gate === 'architecture');
    expect(gate?.violations).toHaveLength(0);
    expect(gate?.baselinedCount).toBe(1);
    const advisory = run.advisories.find((a) => a.kind === 'baseline-moved');
    expect(advisory?.message).toBe('1 entry transferred (file moves).');
  });

  describe('custom.host registration surface (docs/proposals/rule-expansion-evaluation.md §B.0)', () => {
    it('a registered predicate is validated (not error) and executes — fires red, is baseline-able, and a fix flips the run fresh green (registration -> execution e2e)', async () => {
      const ruleset = defineProject({
        components: { api: 'application/api/**' },
        rules: (c) => [c.custom.host('route-thinness').because('Route handlers stay thin.')],
      });
      let flagFile = true;
      const predicate: HostPredicate = (ctx) =>
        flagFile ? ctx.files.filter((f) => f.endsWith('routes.ts')).map((f) => ({ file: f, message: 'route handler is not thin' })) : [];
      const registry = new StaticPluginRegistry([
        fakePlugin(() => graph([node('application/api/routes.ts', 'api')], [])),
      ]);
      const baseline = new InMemoryBaselineStore();
      const orchestrator = new GateOrchestrator(registry, ruleset, baseline, new Map([['route-thinness', predicate]]));

      const redRun = await orchestrator.check({ rootDir: '/repo', excludes: [] });
      expect(redRun.verdict).toBe('red');
      const redGate = redRun.gates.find((g) => g.gate === 'architecture');
      expect(redGate?.violations).toHaveLength(1);
      const v = redGate?.violations[0];
      expect(v?.kind).toBe('custom');
      if (v?.kind === 'custom') {
        expect(v.hostRuleName).toBe('route-thinness');
        expect(v.because).toBe('Route handlers stay thin.');
      }

      // Baseline-able: accepting it turns the run green while still counting it (tolerated debt).
      baseline.accept(redGate?.violations ?? [], 'manual');
      const baselinedRun = await orchestrator.check({ rootDir: '/repo', excludes: [] });
      expect(baselinedRun.verdict).toBe('green');
      const baselinedGate = baselinedRun.gates.find((g) => g.gate === 'architecture');
      expect(baselinedGate?.baselinedCount).toBe(1);
      expect(baselinedGate?.violations).toHaveLength(0);

      // Fix: the predicate now finds nothing (as if the route handler were slimmed down) — a
      // completely fresh check (ADR 005, no restart required) reports green with zero baselined,
      // exactly like `arch.*` rules do after a real code fix.
      flagFile = false;
      const fixedRun = await orchestrator.check({ rootDir: '/repo', excludes: [] });
      expect(fixedRun.verdict).toBe('green');
      const fixedGate = fixedRun.gates.find((g) => g.gate === 'architecture');
      expect(fixedGate?.violations).toHaveLength(0);
      expect(fixedGate?.baselinedCount).toBe(0);
    });

    it('a custom.host rule referencing a name absent from a non-empty registry still errors (unregistered stays unregistered)', async () => {
      const ruleset = defineProject({
        components: { api: 'application/api/**' },
        rules: (c) => [c.custom.host('route-thinness')],
      });
      const registry = new StaticPluginRegistry([fakePlugin(() => graph([node('application/api/a.ts', 'api')], []))]);
      // A registry with a DIFFERENT predicate registered — proves this isn't "any non-empty
      // registry passes," only the exact registered name does.
      const orchestrator = new GateOrchestrator(
        registry,
        ruleset,
        new InMemoryBaselineStore(),
        new Map([['some-other-predicate', (): [] => []]]),
      );
      const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
      expect(run.verdict).toBe('error');
      const archGate = run.gates.find((g) => g.gate === 'architecture');
      expect(archGate?.status).toBe('error');
      expect(archGate?.errorMessage).toContain("'route-thinness'");
    });

    it('a predicate that throws surfaces as gate error, never a silent pass or an unattributed crash (ADR 008 amendment)', async () => {
      const ruleset = defineProject({
        components: { api: 'application/api/**' },
        rules: (c) => [c.custom.host('route-thinness')],
      });
      const buggyPredicate: HostPredicate = () => {
        throw new Error('predicate has a bug');
      };
      const registry = new StaticPluginRegistry([fakePlugin(() => graph([node('application/api/a.ts', 'api')], []))]);
      const orchestrator = new GateOrchestrator(
        registry,
        ruleset,
        new InMemoryBaselineStore(),
        new Map([['route-thinness', buggyPredicate]]),
      );
      const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
      expect(run.verdict).toBe('error');
      const archGate = run.gates.find((g) => g.gate === 'architecture');
      expect(archGate?.status).toBe('error');
      expect(archGate?.errorMessage).toContain('predicate has a bug');
      expect(archGate?.errorMessage).toContain("'route-thinness'");
    });
  });

  it('does NOT swallow a genuinely new identical violation while the renamed original coexists', async () => {
    const ruleset = defineProject({
      components: { api: 'application/api/**', ui: 'application/ui/**' },
      rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],
    });
    const registry = new StaticPluginRegistry([
      fakePlugin(() =>
        graph(
          [node('application/api/a.ts', 'api'), node('application/ui/b.ts', 'ui')],
          [edge('application/api/a.ts', 'application/ui/b.ts', { specifier: '../ui/b', line: 3 })],
        ),
      ),
    ]);
    const baseline = new InMemoryBaselineStore();
    const orchestrator = new GateOrchestrator(registry, ruleset, baseline);
    const seedRun = await orchestrator.check({ rootDir: '/repo', excludes: [] });
    baseline.accept(seedRun.gates.find((g) => g.gate === 'architecture')?.violations ?? [], 'init-seed');
    expect((await orchestrator.check({ rootDir: '/repo', excludes: [] })).verdict).toBe('green');

    // A second, unrelated file introduces the identical-snippet violation while the original
    // file/violation is untouched — this must surface as new/red, not be swallowed as a "move".
    const registry2 = new StaticPluginRegistry([
      fakePlugin(() =>
        graph(
          [node('application/api/a.ts', 'api'), node('application/api/z.ts', 'api'), node('application/ui/b.ts', 'ui')],
          [
            edge('application/api/a.ts', 'application/ui/b.ts', { specifier: '../ui/b', line: 3 }),
            edge('application/api/z.ts', 'application/ui/b.ts', { specifier: '../ui/b', line: 3 }),
          ],
        ),
      ),
    ]);
    const orchestrator2 = new GateOrchestrator(registry2, ruleset, baseline);
    const run = await orchestrator2.check({ rootDir: '/repo', excludes: [] });
    expect(run.verdict).toBe('red');
    const gate = run.gates.find((g) => g.gate === 'architecture');
    expect(gate?.violations).toHaveLength(1);
    expect(gate?.violations[0]?.file).toBe('application/api/z.ts');
    expect(gate?.baselinedCount).toBe(1);
  });

  describe('security gate (ADR 013)', () => {
    it('is green with 0 manifests when no manifest scanner is injected (default, back-compat for every pre-existing caller)', async () => {
      const ruleset = defineProject({ components: { api: 'application/api/**' } });
      const registry = new StaticPluginRegistry([fakePlugin(() => graph([node('application/api/a.ts', 'api')], []))]);
      const orchestrator = new GateOrchestrator(registry, ruleset, new InMemoryBaselineStore());
      const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
      expect(run.gates.map((g) => g.gate)).toEqual(['parse', 'architecture', 'security']);
      const securityGate = run.gates.find((g) => g.gate === 'security');
      expect(securityGate?.status).toBe('green');
      expect(securityGate?.dependsOn).toEqual([]);
    });

    it('is red when a security.manifest.source-hygiene rule finds a non-registry specifier', async () => {
      const ruleset = defineProject({
        components: { api: 'application/api/**' },
        rules: (c) => [c.security.manifest.sourceHygiene()],
      });
      const registry = new StaticPluginRegistry([fakePlugin(() => graph([node('application/api/a.ts', 'api')], []))]);
      const manifestScanner = fakeManifestScanner({
        manifests: [
          {
            file: toRepoRelativePath('package.json'),
            raw: '{}',
            dependencies: [{ name: 'xlsx', specifier: 'https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz', field: 'dependencies' }],
          },
        ],
        lockfilePresent: true,
      });
      const orchestrator = new GateOrchestrator(registry, ruleset, new InMemoryBaselineStore(), new Map(), manifestScanner);
      const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
      expect(run.verdict).toBe('red');
      const securityGate = run.gates.find((g) => g.gate === 'security');
      expect(securityGate?.status).toBe('red');
      expect(securityGate?.violations).toHaveLength(1);
      expect(securityGate?.violations[0]?.category).toBe('security');
    });

    it('baseline consent (ADR 006): accepting the current dependency set turns a fresh security.manifest.new-dependency rule green, and a newly added dep is red until accepted', async () => {
      const ruleset = defineProject({
        components: { api: 'application/api/**' },
        rules: (c) => [c.security.manifest.newDependencyGate()],
      });
      const registry = new StaticPluginRegistry([fakePlugin(() => graph([node('application/api/a.ts', 'api')], []))]);
      let deps: { name: string; specifier: string; field: 'dependencies' | 'devDependencies' }[] = [
        { name: 'zod', specifier: '^3.23.8', field: 'dependencies' },
      ];
      const manifestScanner: ManifestScanner = {
        scan: () => ({ manifests: [{ file: toRepoRelativePath('package.json'), raw: '{}', dependencies: deps }], lockfilePresent: true }),
      };
      const baseline = new InMemoryBaselineStore();
      const orchestrator = new GateOrchestrator(registry, ruleset, baseline, new Map(), manifestScanner);

      const seedRun = await orchestrator.check({ rootDir: '/repo', excludes: [] });
      const seedGate = seedRun.gates.find((g) => g.gate === 'security');
      expect(seedGate?.status).toBe('red');
      baseline.accept(seedGate?.violations ?? [], 'init-seed');

      const greenRun = await orchestrator.check({ rootDir: '/repo', excludes: [] });
      expect(greenRun.gates.find((g) => g.gate === 'security')?.status).toBe('green');
      expect(greenRun.verdict).toBe('green');

      // A genuinely new dependency is added — same manifest, one more name.
      deps = [...deps, { name: '@anthropic-ai/sdk', specifier: '^0.30.0', field: 'dependencies' }];
      const redRun = await orchestrator.check({ rootDir: '/repo', excludes: [] });
      const redGate = redRun.gates.find((g) => g.gate === 'security');
      expect(redGate?.status).toBe('red');
      expect(redGate?.violations).toHaveLength(1);
      expect(redGate?.violations[0]).toMatchObject({ kind: 'manifest-new-dependency', depName: '@anthropic-ai/sdk' });
      expect(redGate?.baselinedCount).toBe(1);
    });

    it('always runs even when the TypeScript scan throws (ADR 008 always-run carve-out — dependsOn: [])', async () => {
      const ruleset = defineProject({
        components: { api: 'application/api/**' },
        rules: (c) => [c.security.manifest.sourceHygiene()],
      });
      const registry = new StaticPluginRegistry([
        fakePlugin(() => {
          throw new Error('scanner crashed');
        }),
      ]);
      const manifestScanner = fakeManifestScanner({
        manifests: [
          { file: toRepoRelativePath('package.json'), raw: '{}', dependencies: [{ name: 'xlsx', specifier: 'https://cdn.sheetjs.com/xlsx.tgz', field: 'dependencies' }] },
        ],
        lockfilePresent: true,
      });
      const orchestrator = new GateOrchestrator(registry, ruleset, new InMemoryBaselineStore(), new Map(), manifestScanner);
      const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
      expect(run.verdict).toBe('error'); // parse gate still errors — verdict reflects the worst gate
      const securityGate = run.gates.find((g) => g.gate === 'security');
      expect(securityGate?.status).toBe('red'); // the security gate itself ran fine and found a real violation
      expect(securityGate?.violations).toHaveLength(1);
    });

    it('reports gate error (never a silent zero) when the manifest scanner itself throws', async () => {
      const ruleset = defineProject({
        components: { api: 'application/api/**' },
        rules: (c) => [c.security.manifest.sourceHygiene()],
      });
      const registry = new StaticPluginRegistry([fakePlugin(() => graph([node('application/api/a.ts', 'api')], []))]);
      const brokenScanner: ManifestScanner = {
        scan: () => {
          throw new Error('manifest scan blew up');
        },
      };
      const orchestrator = new GateOrchestrator(registry, ruleset, new InMemoryBaselineStore(), new Map(), brokenScanner);
      const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
      const securityGate = run.gates.find((g) => g.gate === 'security');
      expect(securityGate?.status).toBe('error');
      expect(securityGate?.errorMessage).toContain('manifest scan blew up');
      expect(run.verdict).toBe('error');
    });

    it('architecture and security violations are correctly partitioned by category (ruleCategoryOf, ADR 013)', async () => {
      const ruleset = defineProject({
        components: { api: 'application/api/**', ui: 'application/ui/**' },
        rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui), c.security.manifest.sourceHygiene()],
      });
      const registry = new StaticPluginRegistry([
        fakePlugin(() =>
          graph(
            [node('application/api/a.ts', 'api'), node('application/ui/b.ts', 'ui')],
            [edge('application/api/a.ts', 'application/ui/b.ts', { specifier: '../ui/b', line: 3 })],
          ),
        ),
      ]);
      const manifestScanner = fakeManifestScanner({
        manifests: [{ file: toRepoRelativePath('package.json'), raw: '{}', dependencies: [{ name: 'xlsx', specifier: 'https://cdn.sheetjs.com/xlsx.tgz', field: 'dependencies' }] }],
        lockfilePresent: true,
      });
      const orchestrator = new GateOrchestrator(registry, ruleset, new InMemoryBaselineStore(), new Map(), manifestScanner);
      const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });
      const archGate = run.gates.find((g) => g.gate === 'architecture');
      const securityGate = run.gates.find((g) => g.gate === 'security');
      expect(archGate?.violations).toHaveLength(1);
      expect(archGate?.violations[0]?.kind).toBe('no-dependency');
      expect(securityGate?.violations).toHaveLength(1);
      expect(securityGate?.violations[0]?.kind).toBe('manifest-source-hygiene');
    });
  });
});
