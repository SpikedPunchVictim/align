import { describe, expect, it } from 'vitest';
import { toRepoRelativePath } from '@align/core';
import { isFileCovered } from '../src/coverage.js';
import { edge, graph, node } from './helpers.js';

describe('isFileCovered', () => {
  it('is covered when a test file directly imports the target', () => {
    const g = graph(
      [node('src/a.ts', 'core'), node('src/a.test.ts', 'core')],
      [edge('src/a.test.ts', 'src/a.ts')],
    );
    expect(isFileCovered(toRepoRelativePath('src/a.ts'), g)).toBe(true);
  });

  it('is covered transitively (test -> helper -> target)', () => {
    const g = graph(
      [node('src/a.ts', 'core'), node('src/helper.ts', 'core'), node('src/a.spec.ts', 'core')],
      [edge('src/a.spec.ts', 'src/helper.ts'), edge('src/helper.ts', 'src/a.ts')],
    );
    expect(isFileCovered(toRepoRelativePath('src/a.ts'), g)).toBe(true);
  });

  it('is not covered when no test file reaches the target', () => {
    const g = graph(
      [node('src/a.ts', 'core'), node('src/b.test.ts', 'core'), node('src/b.ts', 'core')],
      [edge('src/b.test.ts', 'src/b.ts')],
    );
    expect(isFileCovered(toRepoRelativePath('src/a.ts'), g)).toBe(false);
  });

  it('is not covered when the repo has no test files at all', () => {
    const g = graph([node('src/a.ts', 'core')], []);
    expect(isFileCovered(toRepoRelativePath('src/a.ts'), g)).toBe(false);
  });
});
