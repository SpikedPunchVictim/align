import { describe, expect, it } from 'vitest';
import { toRepoRelativePath } from '@spikedpunch/align-core';
import { MemoizingFixProvider } from '../src/fixProvider.js';
import type { FixProviderInput } from '../src/fixProvider.js';
import { FakeFixProvider } from './fakeFixProvider.js';

function input(content = 'const a = 1;\n'): FixProviderInput {
  return {
    violations: [],
    fileContents: new Map([[toRepoRelativePath('a.ts'), content]]),
    condensedSymbolTable: [],
    ruleExplanations: [],
  };
}

describe('MemoizingFixProvider', () => {
  it('calls the inner provider once for identical input, twice for different input', async () => {
    const fake = new FakeFixProvider();
    fake.script(toRepoRelativePath('a.ts'), [
      { files: [{ path: 'a.ts', edits: [{ search: 'x', replace: 'y' }] }], rationale: 'r1' },
    ]);
    const memo = new MemoizingFixProvider(fake);

    const a = input();
    const b = input(); // identical content -> identical hash
    await memo.proposeFix(a);
    await memo.proposeFix(b);
    expect(memo.providerCallCount).toBe(1);
    expect(fake.calls).toHaveLength(1);

    const c = input('const a = 2;\n'); // different content -> different hash
    fake.script(toRepoRelativePath('a.ts'), [
      { files: [{ path: 'a.ts', edits: [{ search: 'x', replace: 'y' }] }], rationale: 'r2' },
    ]);
    await memo.proposeFix(c);
    expect(memo.providerCallCount).toBe(2);
  });

  it('does not memoize a rejected call — a retry after failure re-invokes the provider', async () => {
    let attempts = 0;
    const inner = {
      async proposeFix(): Promise<never> {
        attempts += 1;
        throw new Error('boom');
      },
    };
    const memo = new MemoizingFixProvider(inner);
    await expect(memo.proposeFix(input())).rejects.toThrow('boom');
    await expect(memo.proposeFix(input())).rejects.toThrow('boom');
    expect(attempts).toBe(2);
  });
});
