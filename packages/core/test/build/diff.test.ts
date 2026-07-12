import { describe, expect, it } from 'vitest';
import { diffGeneratedRules } from '../../src/build/diff.js';
import type { RuleIR } from '../../src/types/ir.js';

function rule(id: string, extra: Partial<RuleIR> = {}): RuleIR {
  return { kind: 'arch.no-dependency', id, from: 'a', to: 'b', provenance: {}, ...extra } as RuleIR;
}

describe('diffGeneratedRules', () => {
  it('classifies added, removed, changed, and unchanged', () => {
    const existing = [rule('keep'), rule('drop'), rule('mod', { provenance: { because: 'old' } })];
    const proposed = [rule('keep'), rule('new'), rule('mod', { provenance: { because: 'new' } })];

    const diff = diffGeneratedRules(existing, proposed);
    expect(diff.added.map((r) => r.id)).toEqual(['new']);
    expect(diff.removed.map((r) => r.id)).toEqual(['drop']);
    expect(diff.changed.map((c) => c.after.id)).toEqual(['mod']);
    expect(diff.unchanged.map((r) => r.id)).toEqual(['keep']);
  });

  it('two empty inputs are an empty diff', () => {
    const diff = diffGeneratedRules([], []);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
  });

  it('is insensitive to object key insertion order', () => {
    const a: RuleIR = { id: 'x', kind: 'arch.no-dependency', from: 'a', to: 'b', provenance: {} } as RuleIR;
    const b: RuleIR = { from: 'a', kind: 'arch.no-dependency', id: 'x', provenance: {}, to: 'b' } as RuleIR;
    const diff = diffGeneratedRules([a], [b]);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(1);
  });
});
