import { describe, expect, it } from 'vitest';
import { expandBraces, globMatch, lintGlobPattern } from '../src/components/glob.js';

describe('globMatch', () => {
  it('matches ** as zero or more path segments', () => {
    expect(globMatch('packages/core/**', 'packages/core/src/index.ts')).toBe(true);
    expect(globMatch('packages/core/**', 'packages/core/index.ts')).toBe(true);
    expect(globMatch('packages/core/**', 'packages/other/index.ts')).toBe(false);
  });

  it('matches any alternative in a brace group (the {anthropic,ollama,openai} report)', () => {
    const pattern = 'src/llm-{anthropic,ollama,openai}/**';
    expect(globMatch(pattern, 'src/llm-anthropic/client.ts')).toBe(true);
    expect(globMatch(pattern, 'src/llm-ollama/client.ts')).toBe(true);
    expect(globMatch(pattern, 'src/llm-openai/client.ts')).toBe(true);
    expect(globMatch(pattern, 'src/llm-gemini/client.ts')).toBe(false);
    expect(globMatch(pattern, 'src/llm-types/index.ts')).toBe(false);
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

describe('expandBraces', () => {
  it('leaves a brace-free pattern untouched', () => {
    expect(expandBraces('packages/core/**')).toEqual(['packages/core/**']);
  });

  it('expands a single flat group', () => {
    expect(expandBraces('llm-{a,b,c}/**')).toEqual(['llm-a/**', 'llm-b/**', 'llm-c/**']);
  });

  it('expands multiple sibling groups as a cartesian product', () => {
    expect(expandBraces('{a,b}/{c,d}')).toEqual(['a/c', 'a/d', 'b/c', 'b/d']);
  });
});

describe('lintGlobPattern', () => {
  it('accepts the supported dialect (*, **, ?, {a,b}, literals)', () => {
    expect(lintGlobPattern('packages/*/src/**')).toBeUndefined();
    expect(lintGlobPattern('src/llm-{anthropic,ollama}/**')).toBeUndefined();
    expect(lintGlobPattern('app/api/routes.ts')).toBeUndefined();
  });

  it('rejects character classes, extglobs, and alternation', () => {
    expect(lintGlobPattern('llm-[ao]*/**')).toMatch(/character class/);
    expect(lintGlobPattern('src/(a|b)/**')).toMatch(/extglob|alternation/);
  });

  it('rejects negation and malformed/nested/range braces', () => {
    expect(lintGlobPattern('!src/**')).toMatch(/negated/);
    expect(lintGlobPattern('src/{a,{b,c}}/**')).toMatch(/nested/);
    expect(lintGlobPattern('src/{a,b/**')).toMatch(/unmatched/);
    expect(lintGlobPattern('src/{a..z}/**')).toMatch(/range/);
  });
});
