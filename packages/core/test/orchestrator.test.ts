import { describe, expect, it } from 'vitest';
import { GateOrchestrator } from '../src/orchestrator.js';
import { InMemoryBaselineStore } from '../src/baseline/store.js';
import { StaticPluginRegistry, type LanguagePlugin } from '../src/plugin/registry.js';
import { defineProject } from '../src/dsl/index.js';
import { edge, graph, node } from './helpers.js';
import type { ScanInput } from '../src/scanner.js';

function fakePlugin(build: (input: ScanInput) => ReturnType<typeof graph>): LanguagePlugin {
  return {
    id: 'fake',
    fileMatch: ['**/*.ts'],
    scanner: { scan: async (input: ScanInput) => build(input) },
  };
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
    expect(run.gates.map((g) => g.gate)).toEqual(['parse', 'architecture']);
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
});
