import { describe, expect, it } from 'vitest';
import { evaluateLayers, evaluateNoCycles, evaluateNoDependency } from '../src/rules/evaluators.js';
import type { ArchLayersRule, ArchNoCyclesRule, ArchNoDependencyRule } from '../src/types/ir.js';
import { edge, graph, node } from './helpers.js';

describe('evaluateNoDependency', () => {
  it('flags an edge from the forbidden component to the target component', () => {
    const g = graph(
      [node('api/a.ts', 'api'), node('ui/b.ts', 'ui')],
      [edge('api/a.ts', 'ui/b.ts', { specifier: '../ui/b', line: 5 })],
    );
    const rule: ArchNoDependencyRule = {
      kind: 'arch.no-dependency',
      id: 'r1',
      from: 'api',
      to: 'ui',
      provenance: {},
    };
    const violations = evaluateNoDependency(rule, g, {});
    expect(violations).toHaveLength(1);
    const v = violations[0];
    expect(v?.kind).toBe('no-dependency');
    if (v?.kind === 'no-dependency') {
      expect(v.fromFile).toBe('api/a.ts');
      expect(v.toFile).toBe('ui/b.ts');
      expect(v.line).toBe(5);
      expect(v.specifier).toBe('../ui/b');
    }
  });

  it('does not flag edges outside the forbidden pair', () => {
    const g = graph(
      [node('api/a.ts', 'api'), node('core/b.ts', 'core')],
      [edge('api/a.ts', 'core/b.ts')],
    );
    const rule: ArchNoDependencyRule = { kind: 'arch.no-dependency', id: 'r1', from: 'api', to: 'ui', provenance: {} };
    expect(evaluateNoDependency(rule, g, {})).toHaveLength(0);
  });

  it('produces a stable fingerprint unaffected by unrelated edges', () => {
    const g1 = graph(
      [node('api/a.ts', 'api'), node('ui/b.ts', 'ui')],
      [edge('api/a.ts', 'ui/b.ts', { specifier: '../ui/b', line: 5 })],
    );
    const g2 = graph(
      [node('api/a.ts', 'api'), node('ui/b.ts', 'ui'), node('core/c.ts', 'core')],
      [edge('api/a.ts', 'ui/b.ts', { specifier: '../ui/b', line: 5 }), edge('api/a.ts', 'core/c.ts')],
    );
    const rule: ArchNoDependencyRule = { kind: 'arch.no-dependency', id: 'r1', from: 'api', to: 'ui', provenance: {} };
    const id1 = evaluateNoDependency(rule, g1, {})[0]?.id;
    const id2 = evaluateNoDependency(rule, g2, {})[0]?.id;
    expect(id1).toBeDefined();
    expect(id1).toBe(id2);
  });
});

describe('evaluateNoCycles', () => {
  it('detects a two-file cycle with per-edge chain detail', () => {
    const g = graph(
      [node('a.ts', 'core'), node('b.ts', 'core')],
      [edge('a.ts', 'b.ts', { specifier: './b', line: 1 }), edge('b.ts', 'a.ts', { specifier: './a', line: 2 })],
    );
    const rule: ArchNoCyclesRule = { kind: 'arch.no-cycles', id: 'r1', scope: 'repo', includeTypeOnly: false, provenance: {} };
    const violations = evaluateNoCycles(rule, g, {});
    expect(violations).toHaveLength(1);
    const v = violations[0];
    expect(v?.kind).toBe('no-cycles');
    if (v?.kind === 'no-cycles') {
      expect(v.chain.length).toBeGreaterThanOrEqual(2);
      expect(v.chain[0]?.specifier).toBeDefined();
      expect(v.suggestedBreakEdge).toBeDefined();
    }
  });

  it('excludes type-only edges by default', () => {
    const g = graph(
      [node('a.ts', 'core'), node('b.ts', 'core')],
      [edge('a.ts', 'b.ts', { kind: 'type-only' }), edge('b.ts', 'a.ts', { kind: 'type-only' })],
    );
    const rule: ArchNoCyclesRule = { kind: 'arch.no-cycles', id: 'r1', scope: 'repo', includeTypeOnly: false, provenance: {} };
    expect(evaluateNoCycles(rule, g, {})).toHaveLength(0);
  });

  it('includes type-only edges when includeTypeOnly is true', () => {
    const g = graph(
      [node('a.ts', 'core'), node('b.ts', 'core')],
      [edge('a.ts', 'b.ts', { kind: 'type-only' }), edge('b.ts', 'a.ts', { kind: 'type-only' })],
    );
    const rule: ArchNoCyclesRule = { kind: 'arch.no-cycles', id: 'r1', scope: 'repo', includeTypeOnly: true, provenance: {} };
    expect(evaluateNoCycles(rule, g, {})).toHaveLength(1);
  });

  it('detects a self-loop', () => {
    const g = graph([node('a.ts', 'core')], [edge('a.ts', 'a.ts', { specifier: './a' })]);
    const rule: ArchNoCyclesRule = { kind: 'arch.no-cycles', id: 'r1', scope: 'repo', includeTypeOnly: false, provenance: {} };
    expect(evaluateNoCycles(rule, g, {})).toHaveLength(1);
  });

  it('detects a multi-node SCC cycle', () => {
    const g = graph(
      [node('a.ts', 'core'), node('b.ts', 'core'), node('c.ts', 'core')],
      [edge('a.ts', 'b.ts'), edge('b.ts', 'c.ts'), edge('c.ts', 'a.ts')],
    );
    const rule: ArchNoCyclesRule = { kind: 'arch.no-cycles', id: 'r1', scope: 'repo', includeTypeOnly: false, provenance: {} };
    const violations = evaluateNoCycles(rule, g, {});
    expect(violations).toHaveLength(1);
    const v = violations[0];
    if (v?.kind === 'no-cycles') expect(v.chain).toHaveLength(3);
  });

  it('scopes to a single component when scope is a ComponentRef', () => {
    const g = graph(
      [node('core/a.ts', 'core'), node('core/b.ts', 'core'), node('ui/c.ts', 'ui')],
      [edge('core/a.ts', 'core/b.ts'), edge('core/b.ts', 'core/a.ts'), edge('ui/c.ts', 'ui/c.ts')],
    );
    const rule: ArchNoCyclesRule = { kind: 'arch.no-cycles', id: 'r1', scope: 'ui', includeTypeOnly: false, provenance: {} };
    const violations = evaluateNoCycles(rule, g, {});
    expect(violations).toHaveLength(1); // only the ui self-loop, core cycle out of scope
  });
});

describe('evaluateLayers', () => {
  it('allows edges within the allowlist and flags edges outside it', () => {
    const g = graph(
      [node('cli/a.ts', 'cli'), node('core/b.ts', 'core'), node('ui/c.ts', 'ui')],
      [edge('cli/a.ts', 'core/b.ts'), edge('cli/a.ts', 'ui/c.ts')],
    );
    const rule: ArchLayersRule = {
      kind: 'arch.layers',
      id: 'r1',
      layers: [{ layer: 'cli', canDependOn: ['core'] }],
      provenance: {},
    };
    const violations = evaluateLayers(rule, g, {});
    expect(violations).toHaveLength(1);
    const v = violations[0];
    if (v?.kind === 'layers') {
      expect(v.fromLayer).toBe('cli');
      expect(v.toLayer).toBe('ui');
    }
  });

  it('always allows intra-layer edges even if not explicitly listed', () => {
    const g = graph(
      [node('cli/a.ts', 'cli'), node('cli/b.ts', 'cli')],
      [edge('cli/a.ts', 'cli/b.ts')],
    );
    const rule: ArchLayersRule = { kind: 'arch.layers', id: 'r1', layers: [{ layer: 'cli', canDependOn: [] }], provenance: {} };
    expect(evaluateLayers(rule, g, {})).toHaveLength(0);
  });
});
