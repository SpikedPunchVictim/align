import { describe, expect, it } from 'vitest';
import { toRepoRelativePath } from '@align/core';
import { findForbiddenPathsInProposal, groupViolationsByFile, isForbiddenPath, usesSuppressions } from '../src/rails.js';
import type { FixProposal } from '@align/core';

function proposal(files: FixProposal['files'], suppressions?: FixProposal['suppressions']): FixProposal {
  return { files, rationale: 'test', ...(suppressions !== undefined ? { suppressions } : {}) };
}

describe('isForbiddenPath', () => {
  it('rejects align.config.ts', () => {
    expect(isForbiddenPath('align.config.ts')).toBe(true);
  });
  it('rejects anything under .align/', () => {
    expect(isForbiddenPath('.align/baseline.json')).toBe(true);
    expect(isForbiddenPath('.align/generated-rules.json')).toBe(true);
  });
  it('rejects path traversal and absolute paths', () => {
    expect(isForbiddenPath('../outside.ts')).toBe(true);
    expect(isForbiddenPath('/etc/passwd')).toBe(true);
  });
  it('allows an ordinary repo-relative source file', () => {
    expect(isForbiddenPath('src/a.ts')).toBe(false);
  });
});

describe('findForbiddenPathsInProposal', () => {
  it('flags a proposal that touches align.config.ts', () => {
    const p = proposal([{ path: 'align.config.ts', edits: [{ search: 'x', replace: 'y' }] }]);
    expect(findForbiddenPathsInProposal(p)).toEqual([{ path: 'align.config.ts' }]);
  });
  it('returns empty for an in-bounds proposal', () => {
    const p = proposal([{ path: 'src/a.ts', edits: [{ search: 'x', replace: 'y' }] }]);
    expect(findForbiddenPathsInProposal(p)).toEqual([]);
  });
});

describe('usesSuppressions', () => {
  it('is false when suppressions is absent', () => {
    expect(usesSuppressions(proposal([{ path: 'a.ts', edits: [{ search: 'x', replace: 'y' }] }]))).toBe(false);
  });
  it('is true when suppressions is non-empty (dormant machinery, rejected downstream)', () => {
    const p = proposal(
      [{ path: 'a.ts', edits: [{ search: 'x', replace: 'y' }] }],
      [{ ruleId: 'lint.no-console', file: 'a.ts', line: 1 }],
    );
    expect(usesSuppressions(p)).toBe(true);
  });
});

describe('groupViolationsByFile', () => {
  it('groups by file, preserving first-seen order per file', () => {
    const violations = [
      { file: toRepoRelativePath('a.ts'), id: 1 },
      { file: toRepoRelativePath('b.ts'), id: 2 },
      { file: toRepoRelativePath('a.ts'), id: 3 },
    ];
    const groups = groupViolationsByFile(violations);
    expect(groups.get(toRepoRelativePath('a.ts'))).toHaveLength(2);
    expect(groups.get(toRepoRelativePath('b.ts'))).toHaveLength(1);
  });
});
