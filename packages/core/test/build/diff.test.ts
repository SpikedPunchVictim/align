import { describe, expect, it } from 'vitest';
import { diffGeneratedRules } from '../../src/build/diff.js';
import { toRepoRelativePath } from '../../src/types/branded.js';
import type { RuleIR } from '../../src/types/ir.js';

function rule(id: string, extra: Partial<RuleIR> = {}): RuleIR {
  return { kind: 'arch.no-dependency', id, from: 'a', to: 'b', provenance: {}, ...extra } as RuleIR;
}

describe('diffGeneratedRules', () => {
  it('classifies added, removed, changed (structural), and unchanged (byte-identical)', () => {
    const existing = [rule('keep'), rule('drop'), rule('mod', { to: 'other' })];
    const proposed = [rule('keep'), rule('new'), rule('mod', { to: 'changed-target' })];

    const diff = diffGeneratedRules(existing, proposed);
    expect(diff.added.map((r) => r.id)).toEqual(['new']);
    expect(diff.removed.map((r) => r.id)).toEqual(['drop']);
    expect(diff.changed.map((c) => c.after.id)).toEqual(['mod']);
    expect(diff.unchanged.map((r) => r.id)).toEqual(['keep']);
    expect(diff.provenanceOnlyChanged).toHaveLength(0);
  });

  it('two empty inputs are an empty diff', () => {
    const diff = diffGeneratedRules([], []);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
    expect(diff.provenanceOnlyChanged).toHaveLength(0);
  });

  it('is insensitive to object key insertion order', () => {
    const a: RuleIR = { id: 'x', kind: 'arch.no-dependency', from: 'a', to: 'b', provenance: {} } as RuleIR;
    const b: RuleIR = { from: 'a', kind: 'arch.no-dependency', id: 'x', provenance: {}, to: 'b' } as RuleIR;
    const diff = diffGeneratedRules([a], [b]);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(1);
  });

  // Live-session finding, IMPLEMENTATION_PLAN.md Stage 3 log: "propose-diff should separate
  // provenance-only changes from structural ones (agent-attached `because` text made 10
  // byte-identical rules show 'changed')". This is that exact scenario, reproduced.
  describe('provenance-only changes (live-session finding)', () => {
    it('a rule whose ONLY difference is .because() text lands in provenanceOnlyChanged, not changed', () => {
      const existing = [rule('mod', { provenance: {} })];
      const proposed = [rule('mod', { provenance: { because: 'agent-attached rationale' } })];

      const diff = diffGeneratedRules(existing, proposed);
      expect(diff.changed).toHaveLength(0);
      expect(diff.unchanged).toHaveLength(0);
      expect(diff.provenanceOnlyChanged.map((c) => c.after.id)).toEqual(['mod']);
    });

    it('the exact live-session scenario: 10 byte-identical rules with a newly-attached because -> zero structural changes', () => {
      const existing = Array.from({ length: 10 }, (_, i) => rule(`r${i}`, { provenance: {} }));
      const proposed = Array.from({ length: 10 }, (_, i) => rule(`r${i}`, { provenance: { because: `Enforced by docs/ARCHITECTURE-RULES.md rule ${i}.` } }));

      const diff = diffGeneratedRules(existing, proposed);
      expect(diff.changed).toHaveLength(0); // zero structural changes — the bug this fixes
      expect(diff.provenanceOnlyChanged).toHaveLength(10);
      expect(diff.added).toHaveLength(0);
      expect(diff.removed).toHaveLength(0);
    });

    it('a rule with BOTH a structural change AND a provenance change still counts as structural (structural wins)', () => {
      const existing = [rule('mod', { to: 'b', provenance: { because: 'old reason' } })];
      const proposed = [rule('mod', { to: 'c', provenance: { because: 'new reason' } })];

      const diff = diffGeneratedRules(existing, proposed);
      expect(diff.changed.map((c) => c.after.id)).toEqual(['mod']);
      expect(diff.provenanceOnlyChanged).toHaveLength(0);
    });

    it('sourceQuote/sourceLineRange/sourceFile provenance-only edits also classify as provenance-only', () => {
      const existing = [rule('mod', { provenance: { sourceFile: toRepoRelativePath('docs/a.md') } })];
      const proposed = [rule('mod', { provenance: { sourceFile: toRepoRelativePath('docs/b.md'), sourceQuote: 'reworded sentence' } })];

      const diff = diffGeneratedRules(existing, proposed);
      expect(diff.changed).toHaveLength(0);
      expect(diff.provenanceOnlyChanged.map((c) => c.after.id)).toEqual(['mod']);
    });
  });
});
