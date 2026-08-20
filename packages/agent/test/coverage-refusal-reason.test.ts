import { describe, expect, it } from 'vitest';
import { runAgentLoop } from '../src/run.js';
import { FakeFixProvider } from './fakeFixProvider.js';
import { createFakeEffects } from './fakeEffects.js';
import { checkRun, edge, graph, node, violation } from './helpers.js';
import type { RulesetIR } from '@spikedpunch/align-core';
import type { AgentRunOptions } from '../src/run.js';

const emptyRuleset: RulesetIR = { irVersion: '1', components: {}, rules: [] };

/** Mirrors `run.test.ts`'s local helper — same defaults, `allowUntested` overridden per test. */
function opts(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    maxAttempts: 3,
    mode: 'pr',
    allowUntested: true,
    allowSymbolRemovals: true,
    allowIncomplete: false,
    dryRun: false,
    workBranchName: 'align/fixes-test',
    baseBranch: 'main',
    ...overrides,
  };
}

/**
 * LEDGER **D051**, the user-facing half — the refusal must name WHICH situation it found.
 *
 * The agent's coverage gate runs before `fixProvider.proposeFix`, so when it fires nothing is
 * planned, nothing is sent to the model, and no agent session starts. That is deliberate. What was
 * not deliberate is that both reasons for firing produced the same sentence, so a user whose test
 * files were merely invisible to the scan was told, in effect, to go write tests they already had.
 */

const v1 = violation({ id: 'v1', ruleId: 'arch.no-dependency', file: 'src/a.ts' });

function reasonFor(g: ReturnType<typeof graph>): Promise<string> {
  const fake = new FakeFixProvider();
  const handle = createFakeEffects(fake, { 'src/a.ts': 'bad' });
  handle.setGraph(g);
  handle.setCheckRuns([checkRun([v1])]);
  return runAgentLoop(handle.effects, emptyRuleset, opts({ allowUntested: false })).then((r) => {
    expect(r.groups[0]).toMatchObject({ status: 'escalated' });
    expect(fake.calls).toHaveLength(0); // the gate is still ahead of the provider
    return (r.groups[0] as { reason: string }).reason;
  });
}

describe('the coverage refusal says which situation it found [D051]', () => {
  it('no test files scanned at all — points at config, not at writing tests', async () => {
    const reason = await reasonFor(graph([node('src/a.ts', 'core')], []));

    // Before the fix: "zero test coverage — no scanned test file transitively imports this file".
    expect(reason).toMatch(/matched 0 test files/i);
    // "cannot tell", not "is untested" — the distinction the whole fix is about.
    expect(reason).toMatch(/cannot tell/i);
    // The two things that actually cause it, both named so the user can check them.
    expect(reason).toMatch(/excludes/);
    expect(reason).toMatch(/testFiles/);
    // And it must NOT assert something it cannot know.
    expect(reason).not.toMatch(/transitively imports this file/);
  });

  it('test files scanned but none reach this file — the real per-file finding', async () => {
    const g = graph(
      [node('src/a.ts', 'core'), node('src/b.ts', 'core'), node('src/b.test.ts', 'core')],
      [edge('src/b.test.ts', 'src/b.ts')],
    );

    const reason = await reasonFor(g);

    expect(reason).toMatch(/transitively imports this file/);
    // The count is what makes this claim checkable rather than asserted.
    expect(reason).toMatch(/1 test file/);
    expect(reason).toMatch(/--allow-untested/);
  });

  it('both reasons still offer the override [S-04]', async () => {
    // Calibration: the escape hatch is what keeps the gate from being a wall, and it is the thing
    // a user reaches for first. Losing it from either branch would be worse than the wrong wording.
    expect(await reasonFor(graph([node('src/a.ts', 'core')], []))).toMatch(/--allow-untested/);
  });
});
