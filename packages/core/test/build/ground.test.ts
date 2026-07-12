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

  it('defaults no-cycles scope to repo when unspecified', () => {
    const result = groundFragment({ kind: 'arch.no-cycles' }, 'cycles', docPath, range, 'No cycles.', components);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.rule).toMatchObject({ kind: 'arch.no-cycles', scope: 'repo', id: 'arch.no-cycles:repo' });
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
