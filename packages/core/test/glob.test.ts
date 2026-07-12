import { describe, expect, it } from 'vitest';
import { globMatch } from '../src/components/glob.js';

describe('globMatch', () => {
  it('matches ** as zero or more path segments', () => {
    expect(globMatch('packages/core/**', 'packages/core/src/index.ts')).toBe(true);
    expect(globMatch('packages/core/**', 'packages/core/index.ts')).toBe(true);
    expect(globMatch('packages/core/**', 'packages/other/index.ts')).toBe(false);
  });

  it('matches * as a single path segment', () => {
    expect(globMatch('packages/*/src', 'packages/core/src')).toBe(true);
    expect(globMatch('packages/*/src', 'packages/core/nested/src')).toBe(false);
  });

  it('matches literal segments exactly', () => {
    expect(globMatch('application/api/routes.ts', 'application/api/routes.ts')).toBe(true);
    expect(globMatch('application/api/routes.ts', 'application/api/other.ts')).toBe(false);
  });
});
