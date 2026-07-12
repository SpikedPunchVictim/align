import { describe, expect, it } from 'vitest';
import { GeneratedRuleCollisionError, mergeGeneratedRules } from '../../src/build/merge.js';
import type { RuleIR } from '../../src/types/ir.js';

function rule(id: string, extra: Partial<RuleIR> = {}): RuleIR {
  return { kind: 'arch.no-dependency', id, from: 'a', to: 'b', provenance: {}, ...extra } as RuleIR;
}

describe('mergeGeneratedRules', () => {
  it('appends non-colliding generated rules to the base list', () => {
    const merged = mergeGeneratedRules([rule('base')], [rule('generated')]);
    expect(merged.map((r) => r.id).sort()).toEqual(['base', 'generated']);
  });

  it('merges provenance onto a structurally-identical colliding rule, preserving the hand-authored because', () => {
    const base = [rule('shared', { provenance: { because: 'hand-authored rationale' } })];
    const generated = [rule('shared', { provenance: { because: 'Enforced by docs/x.md:1: \'quote\'', sourceFile: 'docs/x.md' } })];
    const merged = mergeGeneratedRules(base, generated);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.provenance.because).toBe("hand-authored rationale Enforced by docs/x.md:1: 'quote'");
    expect(merged[0]?.provenance.sourceFile).toBe('docs/x.md');
  });

  it('throws GeneratedRuleCollisionError when colliding rules structurally disagree', () => {
    const base = [rule('shared', { to: 'b' })];
    const generated = [rule('shared', { to: 'c' })];
    expect(() => mergeGeneratedRules(base, generated)).toThrow(GeneratedRuleCollisionError);
  });

  it('an empty generated list returns the base rules unchanged', () => {
    const base = [rule('only')];
    expect(mergeGeneratedRules(base, [])).toEqual(base);
  });
});
