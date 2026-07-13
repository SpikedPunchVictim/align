import { describe, expect, it } from 'vitest';
import { toRepoRelativePath } from '@spikedpunch/align-core';
import { diffExportedSymbols } from '../src/symbolDiff.js';

describe('diffExportedSymbols', () => {
  it('reports no removals when nothing changed', () => {
    const before = [{ file: toRepoRelativePath('a.ts'), exports: ['A', 'B'] }];
    expect(diffExportedSymbols(before, before)).toEqual([]);
  });

  it('reports a removed exported symbol', () => {
    const before = [{ file: toRepoRelativePath('a.ts'), exports: ['A', 'B'] }];
    const after = [{ file: toRepoRelativePath('a.ts'), exports: ['A'] }];
    expect(diffExportedSymbols(before, after)).toEqual([{ file: toRepoRelativePath('a.ts'), removedSymbols: ['B'] }]);
  });

  it('treats a file missing entirely from `after` as removing all its exports', () => {
    const before = [{ file: toRepoRelativePath('a.ts'), exports: ['A'] }];
    expect(diffExportedSymbols(before, [])).toEqual([{ file: toRepoRelativePath('a.ts'), removedSymbols: ['A'] }]);
  });

  it('ignores added symbols (additions are not a removal concern)', () => {
    const before = [{ file: toRepoRelativePath('a.ts'), exports: ['A'] }];
    const after = [{ file: toRepoRelativePath('a.ts'), exports: ['A', 'B'] }];
    expect(diffExportedSymbols(before, after)).toEqual([]);
  });
});
