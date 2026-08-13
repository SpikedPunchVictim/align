import { describe, expect, it } from 'vitest';
import { expandBraces, globMatch, lintGlobPattern, staticPrefixOf } from '../src/components/glob.js';

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

  it('matches `**` as zero or more WHOLE path segments, not an arbitrary substring (BUG #2)', () => {
    // A `**` that owns a whole segment must not cross segment boundaries: `src/notindex.ts` has
    // no segment boundary before `index.ts`, so it must NOT match `src/**/index.ts`.
    expect(globMatch('src/**/index.ts', 'src/notindex.ts')).toBe(false);
    expect(globMatch('src/**/index.ts', 'src/index.ts')).toBe(true);
    expect(globMatch('src/**/index.ts', 'src/a/b/index.ts')).toBe(true);
    expect(globMatch('app/**/model.ts', 'app/datamodel.ts')).toBe(false);
    expect(globMatch('**/*.ts', 'a.ts')).toBe(true);
    expect(globMatch('**/*.ts', 'x/y/a.ts')).toBe(true);
    expect(globMatch('**', 'anything/at/all.ts')).toBe(true);
    expect(globMatch('packages/*/src/**', 'packages/a/src/b.ts')).toBe(true);
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

// Task #25's registry.ts review fix: `components/registry.ts`'s nested-checkout diagnosis needs
// "what's the literal directory this pattern is anchored under" without a second glob matcher
// (BUG #4's lesson) — this is that narrower question, not a matching function.
describe('staticPrefixOf', () => {
  it('returns the directory before the first wildcard segment', () => {
    expect(staticPrefixOf('vendor/submodule/**')).toBe('vendor/submodule');
    expect(staticPrefixOf('vendored/repo/src/**')).toBe('vendored/repo/src');
    expect(staticPrefixOf('packages/*/src/**')).toBe('packages');
  });

  it('trims back to the last COMPLETE segment — a partial segment is never reported as a real directory', () => {
    expect(staticPrefixOf('vendor/subm*/index.ts')).toBe('vendor');
  });

  it('returns a literal file pattern\'s containing directory', () => {
    expect(staticPrefixOf('vendor/submodule/index.ts')).toBe('vendor/submodule');
  });

  it("returns '' for a pattern with no literal anchor at all (matches everywhere)", () => {
    expect(staticPrefixOf('**')).toBe('');
    expect(staticPrefixOf('*.ts')).toBe('');
  });

  it('stops at a brace group, treating it as a wildcard boundary (conservative, never over-claims a literal)', () => {
    expect(staticPrefixOf('src/llm-{anthropic,ollama}/**')).toBe('src');
  });
});
