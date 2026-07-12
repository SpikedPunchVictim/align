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
      fakePlugin(() => graph([node('application/api/a.ts', 'api')], [])),
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
});
