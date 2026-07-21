import { describe, expect, it } from 'vitest';
import { buildViolationMermaid } from '../src/payload/mermaid.js';
import { computeFingerprint } from '../src/baseline/fingerprint.js';
import { toComponentName, toRepoRelativePath, toRuleId } from '../src/types/branded.js';
import type { CycleEdge, Violation } from '../src/types/violation.js';

function noCyclesViolation(chain: CycleEdge[], suggestedBreakEdge: CycleEdge): Violation {
  return {
    id: computeFingerprint(['no-cycles', 'r1']),
    ruleId: toRuleId('r1'),
    category: 'architecture',
    severity: 'error',
    file: chain[0]?.from ?? toRepoRelativePath('a.ts'),
    range: { startLine: suggestedBreakEdge.line, endLine: suggestedBreakEdge.line },
    snippet: `import x from '${suggestedBreakEdge.specifier}';`,
    fixHint: { code: 'break-cycle-edge', suggestedEdge: suggestedBreakEdge },
    kind: 'no-cycles',
    chain,
    suggestedBreakEdge,
  };
}

function noDependencyViolation(): Violation {
  return {
    id: computeFingerprint(['no-dependency', 'r1']),
    ruleId: toRuleId('r1'),
    category: 'architecture',
    severity: 'error',
    file: toRepoRelativePath('src/api/service.ts'),
    range: { startLine: 1, endLine: 1 },
    snippet: `import { render } from '../ui/component.js';`,
    fixHint: { code: 'remove-import', file: toRepoRelativePath('src/api/service.ts'), line: 1 },
    kind: 'no-dependency',
    fromFile: toRepoRelativePath('src/api/service.ts'),
    toFile: toRepoRelativePath('src/ui/component.ts'),
    fromComponent: toComponentName('api'),
    toComponent: toComponentName('ui'),
    specifier: '../ui/component.js',
    line: 1,
  };
}

function layersViolation(): Violation {
  return {
    id: computeFingerprint(['layers', 'r1']),
    ruleId: toRuleId('r1'),
    category: 'architecture',
    severity: 'error',
    file: toRepoRelativePath('src/api/service.ts'),
    range: { startLine: 1, endLine: 1 },
    snippet: `import { render } from '../ui/component.js';`,
    fixHint: { code: 'remove-import', file: toRepoRelativePath('src/api/service.ts'), line: 1 },
    kind: 'layers',
    fromLayer: toComponentName('api'),
    toLayer: toComponentName('ui'),
    fromFile: toRepoRelativePath('src/api/service.ts'),
    toFile: toRepoRelativePath('src/ui/component.ts'),
    specifier: '../ui/component.js',
    line: 1,
  };
}

function noDependencyExternalViolation(): Violation {
  return {
    id: computeFingerprint(['no-dependency-external', 'r1']),
    ruleId: toRuleId('r1'),
    category: 'architecture',
    severity: 'error',
    file: toRepoRelativePath('packages/core/src/index.ts'),
    range: { startLine: 1, endLine: 1 },
    snippet: `import cp from 'node:child_process';`,
    fixHint: { code: 'remove-import', file: toRepoRelativePath('packages/core/src/index.ts'), line: 1 },
    kind: 'no-dependency-external',
    fromFile: toRepoRelativePath('packages/core/src/index.ts'),
    fromComponent: toComponentName('core'),
    toExternal: 'external:node:child_process',
    externalPackageName: 'child_process',
    specifier: 'node:child_process',
    line: 1,
  };
}

function layersExternalViolation(): Violation {
  return {
    id: computeFingerprint(['layers-external', 'r1']),
    ruleId: toRuleId('r1'),
    category: 'architecture',
    severity: 'error',
    file: toRepoRelativePath('src/web/a.ts'),
    range: { startLine: 1, endLine: 1 },
    snippet: `import _ from 'lodash';`,
    fixHint: { code: 'remove-import', file: toRepoRelativePath('src/web/a.ts'), line: 1 },
    kind: 'layers-external',
    fromLayer: toComponentName('web'),
    fromFile: toRepoRelativePath('src/web/a.ts'),
    toExternal: 'external:lodash',
    externalPackageName: 'lodash',
    specifier: 'lodash',
    line: 1,
  };
}

function customViolation(): Violation {
  return {
    id: computeFingerprint(['custom', 'r1']),
    ruleId: toRuleId('custom.host:route-thinness'),
    category: 'architecture',
    severity: 'error',
    file: toRepoRelativePath('src/api/routes.ts'),
    range: { startLine: 3, endLine: 3 },
    snippet: `export function handler() {}`,
    fixHint: { code: 'manual-review' },
    kind: 'custom',
    hostRuleName: 'route-thinness',
    detail: 'route handler is not thin',
  };
}

describe('buildViolationMermaid', () => {
  it('renders a no-cycles chain with the suggested break edge visually marked', () => {
    const chain: CycleEdge[] = [
      { from: toRepoRelativePath('a.ts'), to: toRepoRelativePath('b.ts'), specifier: './b', line: 1 },
      { from: toRepoRelativePath('b.ts'), to: toRepoRelativePath('c.ts'), specifier: './c', line: 2 },
      { from: toRepoRelativePath('c.ts'), to: toRepoRelativePath('a.ts'), specifier: './a', line: 3 },
    ];
    const suggestedBreakEdge = chain[2];
    if (suggestedBreakEdge === undefined) throw new Error('unreachable');
    const mermaid = buildViolationMermaid(noCyclesViolation(chain, suggestedBreakEdge));

    expect(mermaid.startsWith('```mermaid\ngraph LR')).toBe(true);
    expect(mermaid.endsWith('```')).toBe(true);
    expect(mermaid).toContain('-->|"./b"|'); // normal edges are solid
    expect(mermaid).toContain('-->|"./c"|');
    expect(mermaid).toContain('-. "BREAK: ./a" .->'); // suggested break edge is dashed + labeled
    expect(mermaid).toMatchSnapshot();
  });

  it('renders a no-dependency violation as the offending component/file relationship', () => {
    const mermaid = buildViolationMermaid(noDependencyViolation());
    expect(mermaid).toContain('graph LR');
    expect(mermaid).toContain('api<br/>src/api/service.ts');
    expect(mermaid).toContain('ui<br/>src/ui/component.ts');
    expect(mermaid).toContain('../ui/component.js (forbidden)');
    expect(mermaid).toMatchSnapshot();
  });

  it('renders a layers violation the same way, using layer names', () => {
    const mermaid = buildViolationMermaid(layersViolation());
    expect(mermaid).toContain('api<br/>src/api/service.ts');
    expect(mermaid).toContain('ui<br/>src/ui/component.ts');
    expect(mermaid).toMatchSnapshot();
  });

  it('renders a no-dependency-external violation naming the external package (ADR 017 Part A)', () => {
    const mermaid = buildViolationMermaid(noDependencyExternalViolation());
    expect(mermaid).toContain('graph LR');
    expect(mermaid).toContain('core<br/>packages/core/src/index.ts');
    expect(mermaid).toContain('external:child_process');
    expect(mermaid).toContain('node:child_process (forbidden)');
    expect(mermaid).toMatchSnapshot();
  });

  it('renders a layers-external violation naming the external package (ADR 017 Part A)', () => {
    const mermaid = buildViolationMermaid(layersExternalViolation());
    expect(mermaid).toContain('web<br/>src/web/a.ts');
    expect(mermaid).toContain('external:lodash');
    expect(mermaid).toMatchSnapshot();
  });

  it('renders a custom.host violation as a single node labeled with the predicate name and its message', () => {
    const mermaid = buildViolationMermaid(customViolation());
    expect(mermaid).toContain('graph LR');
    expect(mermaid).toContain('src/api/routes.ts');
    expect(mermaid).toContain('route-thinness');
    expect(mermaid).toContain('route handler is not thin');
    expect(mermaid).toMatchSnapshot();
  });
});
