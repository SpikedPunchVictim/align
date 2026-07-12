import { describe, expect, it } from 'vitest';
import { toRepoRelativePath } from '../../src/types/branded.js';
import { applyEditsToFile, applyFixProposalFiles } from '../../src/fix/apply.js';
import type { EditBlock } from '../../src/fix/schema.js';

const file = toRepoRelativePath('src/example.ts');

function edit(partial: Partial<EditBlock> & Pick<EditBlock, 'search' | 'replace'>): EditBlock {
  return { ...partial };
}

describe('applyEditsToFile', () => {
  it('applies a unique match', () => {
    const original = 'const a = 1;\nconst b = 2;\n';
    const result = applyEditsToFile(original, file, [edit({ search: 'const a = 1;', replace: 'const a = 100;' })]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('const a = 100;\nconst b = 2;\n');
      expect(result.editCount).toBe(1);
    }
  });

  it('rejects with zero-matches when the search block is not found', () => {
    const original = 'const a = 1;\n';
    const result = applyEditsToFile(original, file, [edit({ search: 'const z = 9;', replace: 'x' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe('zero-matches');
    }
  });

  it('disambiguates multiple matches using nearLine (picks the closest)', () => {
    const original = ['function dup() { return 1; }', '', 'function dup() { return 1; }', ''].join('\n');
    // Two identical lines "function dup() { return 1; }" at line 1 and line 3.
    const result = applyEditsToFile(original, file, [
      edit({ search: 'function dup() { return 1; }', replace: 'function dup() { return 2; }', nearLine: 3 }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = result.content.split('\n');
      expect(lines[0]).toBe('function dup() { return 1; }');
      expect(lines[2]).toBe('function dup() { return 2; }');
    }
  });

  it('rejects as ambiguous when multiple matches exist and no nearLine is given', () => {
    const original = 'return x;\nreturn x;\n';
    const result = applyEditsToFile(original, file, [edit({ search: 'return x;', replace: 'return y;' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe('ambiguous-matches');
    }
  });

  it('rejects as ambiguous when nearLine ties between two equidistant matches', () => {
    // Matches on line 1 and line 3; nearLine=2 is equidistant from both.
    const original = 'dup();\nx();\ndup();\n';
    const result = applyEditsToFile(original, file, [edit({ search: 'dup();', replace: 'dup2();', nearLine: 2 })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe('ambiguous-matches');
    }
  });

  it('rejects the entire file atomically on overlapping spans', () => {
    const original = 'const value = compute();\n';
    const result = applyEditsToFile(original, file, [
      edit({ search: 'const value = compute();', replace: 'A' }),
      edit({ search: 'value = compute()', replace: 'B' }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe('overlapping-spans');
    }
  });

  it('applies multiple non-overlapping edits with descending-offset correctness', () => {
    const original = ['line one', 'line two', 'line three', 'line four'].join('\n');
    const result = applyEditsToFile(original, file, [
      edit({ search: 'line one', replace: 'LINE ONE (longer replacement)' }),
      edit({ search: 'line three', replace: 'L3' }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe(['LINE ONE (longer replacement)', 'line two', 'L3', 'line four'].join('\n'));
    }
  });

  it('supports deletion via an empty replace string', () => {
    const original = 'import { unused } from "./x.js";\nconst a = 1;\n';
    const result = applyEditsToFile(original, file, [
      edit({ search: 'import { unused } from "./x.js";\n', replace: '' }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('const a = 1;\n');
    }
  });

  it('re-anchoring FailureContext carries ±3-line line-numbered context of the nearest candidate', () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const original = lines.join('\n');
    // search has a near-miss first line ("e-changed") absent, but the block partially resembles line 5 "e".
    const result = applyEditsToFile(original, file, [edit({ search: 'e\nZZZZZ', replace: 'x' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe('zero-matches');
      expect(result.failure.nearestCandidate).toBeDefined();
      expect(result.failure.nearestCandidate?.linesWithContext).toContain('5: e');
      // ±3 lines around line 5 => lines 2..8
      expect(result.failure.nearestCandidate?.startLine).toBe(2);
    }
  });
});

describe('applyFixProposalFiles', () => {
  it('validates independently per file — one file failing does not block another', () => {
    const originals = new Map([
      [toRepoRelativePath('a.ts'), 'const a = 1;\n'],
      [toRepoRelativePath('b.ts'), 'const b = 1;\n'],
    ]);
    const results = applyFixProposalFiles(
      originals,
      [
        { path: 'a.ts', edits: [{ search: 'const a = 1;', replace: 'const a = 2;' }] },
        { path: 'b.ts', edits: [{ search: 'const b = 999;', replace: 'const b = 2;' }] },
      ],
      toRepoRelativePath,
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true, content: 'const a = 2;\n' });
    expect(results[1]).toMatchObject({ ok: false });
  });

  it('rejects a file whose original content is unavailable', () => {
    const originals = new Map<ReturnType<typeof toRepoRelativePath>, string>();
    const results = applyFixProposalFiles(
      originals,
      [{ path: 'missing.ts', edits: [{ search: 'x', replace: 'y' }] }],
      toRepoRelativePath,
    );
    expect(results[0]).toMatchObject({ ok: false });
  });
});
