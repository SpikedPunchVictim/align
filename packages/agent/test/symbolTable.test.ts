import { describe, expect, it } from 'vitest';
import { toRepoRelativePath } from '@align/core';
import { buildCondensedSymbolTable } from '../src/symbolTable.js';
import { edge, graph, node } from './helpers.js';

describe('buildCondensedSymbolTable', () => {
  it('returns exports of same-component files, excluding the target and empty-export files', () => {
    const g = graph(
      [
        node('src/a.ts', 'core', ['A']),
        node('src/b.ts', 'core', ['B', 'C']),
        node('src/c.ts', 'core', []),
        node('src/other.ts', 'cli', ['D']),
      ],
      [edge('src/a.ts', 'src/b.ts')],
    );
    const table = buildCondensedSymbolTable(toRepoRelativePath('src/a.ts'), g);
    expect(table).toEqual([{ file: toRepoRelativePath('src/b.ts'), exports: ['B', 'C'] }]);
  });

  it('returns an empty table when the target file is not in the graph', () => {
    const g = graph([node('src/a.ts', 'core', ['A'])], []);
    expect(buildCondensedSymbolTable(toRepoRelativePath('src/missing.ts'), g)).toEqual([]);
  });
});
