import { describe, expect, it } from 'vitest';
import { groundComponentRef, groundFragment } from '../../src/build/ground.js';
import { toComponentName, toRepoRelativePath } from '../../src/types/branded.js';
import type { ComponentDefinitionIR } from '../../src/types/ir.js';

const components: Record<string, ComponentDefinitionIR> = {
  core: { name: toComponentName('core'), selector: { kind: 'glob', patterns: ['packages/core/**'] }, allowEmpty: false },
  cli: { name: toComponentName('cli'), selector: { kind: 'glob', patterns: ['packages/cli/**'] }, allowEmpty: false },
};

const docPath = toRepoRelativePath('docs/ARCHITECTURE-RULES.md');
const range = { startLine: 10, endLine: 10 };

describe('groundComponentRef', () => {
  it('matches exactly and strips surrounding backticks', () => {
    expect(groundComponentRef('`core`', components)).toBe('core');
  });

  it('falls back to a case-insensitive match', () => {
    expect(groundComponentRef('Core', components)).toBe('core');
  });

  it('returns undefined for an unknown component', () => {
    expect(groundComponentRef('nonexistent', components)).toBeUndefined();
  });
});

describe('groundFragment', () => {
  it('builds a fully-provenanced no-dependency rule with the "Enforced by" because text', () => {
    const result = groundFragment(
      { kind: 'arch.no-dependency', from: '`core`', to: '`cli`' },
      'isolation',
      docPath,
      range,
      '`core` must not depend on `cli`.',
      components,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.rule.id).toBe('arch.no-dependency:core->cli');
    expect(result.rule.provenance.sourceFile).toBe(docPath);
    expect(result.rule.provenance.sourceLineRange).toEqual(range);
    expect(result.rule.provenance.because).toBe(
      `Enforced by ${docPath}:10: '\`core\` must not depend on \`cli\`.'`,
    );
  });

  it('flags an ungroundable selector rather than writing a phantom rule', () => {
    const result = groundFragment(
      { kind: 'arch.no-dependency', from: '`core`', to: '`nonexistent`' },
      'isolation',
      docPath,
      range,
      'quote',
      components,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.flagged.reason).toBe('ungroundable-selector');
  });

  it('flags a custom.host fragment as unregistered-host-rule rather than writing an unevaluatable rule (v1 has no host predicate registry)', () => {
    const result = groundFragment(
      { kind: 'custom.host', hostRuleName: 'route-thinness' },
      'route-handlers',
      docPath,
      range,
      'Route handlers stay thin.',
      components,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.flagged.reason).toBe('unregistered-host-rule');
    expect(result.flagged.detail).toContain("'route-thinness'");
    expect(result.flagged.detail).toContain('not registered');
  });

  it('defaults no-cycles scope to repo when unspecified', () => {
    const result = groundFragment({ kind: 'arch.no-cycles' }, 'cycles', docPath, range, 'No cycles.', components);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.rule).toMatchObject({ kind: 'arch.no-cycles', scope: 'repo', id: 'arch.no-cycles:repo' });
  });

  it('builds a fully-provenanced arch.metric rule (max-LOC)', () => {
    const result = groundFragment(
      { kind: 'arch.metric', target: '`core`', metric: 'loc', max: 800 },
      'size',
      docPath,
      range,
      'Files in `core` must stay under 800 lines.',
      components,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.rule).toMatchObject({ kind: 'arch.metric', id: 'arch.metric:loc:core', target: 'core', metric: 'loc', max: 800 });
    expect(result.rule.provenance.sourceFile).toBe(docPath);
  });

  it('flags an arch.metric fragment with an ungroundable target', () => {
    const result = groundFragment(
      { kind: 'arch.metric', target: '`nonexistent`', metric: 'loc', max: 800 },
      'size',
      docPath,
      range,
      'quote',
      components,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.flagged.reason).toBe('ungroundable-selector');
  });

  it('prepends an author-supplied because to the auto-populated Enforced-by text', () => {
    const result = groundFragment(
      { kind: 'arch.no-dependency', from: 'core', to: 'cli', because: 'Keeps core headless.' },
      'isolation',
      docPath,
      range,
      'quote',
      components,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.rule.provenance.because).toBe(`Keeps core headless. Enforced by ${docPath}:10: 'quote'`);
  });
});
