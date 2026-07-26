import { describe, expect, it } from 'vitest';
import { toRepoRelativePath, type RulesetIR } from '@spikedpunch/align-core';
import { runAgentLoop, defaultWorkBranchName, type AgentRunOptions } from '../src/run.js';
import { FakeFixProvider } from './fakeFixProvider.js';
import { createFakeEffects } from './fakeEffects.js';
import { checkRun, edge, errorCheckRun, graph, node, violation } from './helpers.js';

const emptyRuleset: RulesetIR = { irVersion: '1', components: {}, rules: [] };

function opts(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    maxAttempts: 3,
    mode: 'pr',
    allowUntested: true,
    allowSymbolRemovals: true,
    dryRun: false,
    workBranchName: 'align/fixes-test',
    baseBranch: 'main',
    ...overrides,
  };
}

describe('runAgentLoop — safety rails', () => {
  it('refuses a dirty worktree without calling the FixProvider', async () => {
    const fake = new FakeFixProvider();
    const handle = createFakeEffects(fake, { 'a.ts': 'x' });
    handle.git.clean = false;
    const result = await runAgentLoop(handle.effects, emptyRuleset, opts());
    expect(result.verdict).toBe('refused');
    expect(result.refusalReason).toMatch(/dirty worktree/);
    expect(fake.calls).toHaveLength(0);
  });

  it('halts on a gate error at DISCOVER without attempting fixes', async () => {
    const fake = new FakeFixProvider();
    const handle = createFakeEffects(fake, { 'a.ts': 'x' });
    handle.setCheckRuns([errorCheckRun()]);
    const result = await runAgentLoop(handle.effects, emptyRuleset, opts());
    expect(result.verdict).toBe('refused');
    expect(fake.calls).toHaveLength(0);
    // The refusal surfaces WHICH gate errored and its errorMessage — not a generic string — so the
    // user can act (regression for the "environmental, not fixable" opaque message).
    expect(result.refusalReason).toContain('architecture gate');
    expect(result.refusalReason).toContain('eslint binary not found');
    expect(result.finalCheck?.verdict).toBe('error');
  });

  it('reports nothing-to-fix when the initial check is green', async () => {
    const fake = new FakeFixProvider();
    const handle = createFakeEffects(fake, {});
    handle.setCheckRuns([checkRun([])]);
    const result = await runAgentLoop(handle.effects, emptyRuleset, opts());
    expect(result.verdict).toBe('nothing-to-fix');
  });
});

describe('runAgentLoop — happy path to DONE + terminal merge', () => {
  it('fixes a single-violation group, commits, and opens a PR', async () => {
    const file = toRepoRelativePath('src/a.ts');
    const v1 = violation({ id: 'v1', ruleId: 'arch.no-dependency', file: 'src/a.ts' });

    const fake = new FakeFixProvider();
    fake.script(file, [
      {
        files: [{ path: 'src/a.ts', edits: [{ search: 'import { bad } from "./bad.js";\n', replace: '' }] }],
        rationale: 'remove forbidden import',
      },
    ]);

    const handle = createFakeEffects(fake, { 'src/a.ts': 'import { bad } from "./bad.js";\nexport const ok = 1;\n' });
    handle.setCheckRuns([checkRun([v1]), checkRun([])]);

    const result = await runAgentLoop(handle.effects, emptyRuleset, opts());

    expect(result.verdict).toBe('done');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ status: 'done', file });
    expect(handle.git.commitLog).toHaveLength(1);
    expect(handle.fs.get(file)).toBe('export const ok = 1;\n');
    expect(result.terminalMerge).toMatchObject({ status: 'pr-created', url: 'https://example.com/pr/1' });
    // The PR body is a violations-fixed summary built from accumulated rationales.
    expect(handle.git.commitLog[0]?.message).toBe('remove forbidden import');
  });

  it('--auto-merge fast-forwards and deletes the work branch instead of opening a PR', async () => {
    const file = toRepoRelativePath('src/a.ts');
    const v1 = violation({ id: 'v1', ruleId: 'arch.no-dependency', file: 'src/a.ts' });
    const fake = new FakeFixProvider();
    fake.script(file, [{ files: [{ path: 'src/a.ts', edits: [{ search: 'bad', replace: 'good' }] }], rationale: 'fix' }]);
    const handle = createFakeEffects(fake, { 'src/a.ts': 'bad' });
    handle.setCheckRuns([checkRun([v1]), checkRun([])]);

    const result = await runAgentLoop(handle.effects, emptyRuleset, opts({ mode: 'auto-merge' }));
    expect(result.terminalMerge).toEqual({ status: 'auto-merged' });
    expect(handle.git.ffMerged).toBe(true);
    expect(handle.git.deletedBranch).toBe('align/fixes-test');
  });

  it('prints a branch name and summary (no PR) when there is no remote/gh', async () => {
    const file = toRepoRelativePath('src/a.ts');
    const v1 = violation({ id: 'v1', ruleId: 'arch.no-dependency', file: 'src/a.ts' });
    const fake = new FakeFixProvider();
    fake.script(file, [{ files: [{ path: 'src/a.ts', edits: [{ search: 'bad', replace: 'good' }] }], rationale: 'fix' }]);
    const handle = createFakeEffects(fake, { 'src/a.ts': 'bad' });
    handle.setCheckRuns([checkRun([v1]), checkRun([])]);
    handle.git.pushShouldSucceed = false;

    const result = await runAgentLoop(handle.effects, emptyRuleset, opts());
    expect(result.terminalMerge).toMatchObject({ status: 'no-remote-or-no-gh', branch: 'align/fixes-test' });
    const summary = (result.terminalMerge as { summary: string }).summary;
    expect(summary).toContain('Violations fixed');
    expect(summary).toContain('src/a.ts');
    expect(summary).toContain('fix'); // the rationale
  });

  it('escalates the terminal merge on rebase conflict without auto-resolving', async () => {
    const file = toRepoRelativePath('src/a.ts');
    const v1 = violation({ id: 'v1', ruleId: 'arch.no-dependency', file: 'src/a.ts' });
    const fake = new FakeFixProvider();
    fake.script(file, [{ files: [{ path: 'src/a.ts', edits: [{ search: 'bad', replace: 'good' }] }], rationale: 'fix' }]);
    const handle = createFakeEffects(fake, { 'src/a.ts': 'bad' });
    handle.setCheckRuns([checkRun([v1]), checkRun([])]);
    handle.git.rebaseShouldConflict = true;

    const result = await runAgentLoop(handle.effects, emptyRuleset, opts());
    expect(result.terminalMerge).toEqual({ status: 'rebase-conflict' });
  });
});

describe('runAgentLoop — REPAIR path', () => {
  it('a bad proposal (zero-match search) reverts nothing (never committed) and retries with FailureContext', async () => {
    const file = toRepoRelativePath('src/a.ts');
    const v1 = violation({ id: 'v1', ruleId: 'arch.no-dependency', file: 'src/a.ts' });
    const fake = new FakeFixProvider();
    fake.script(file, [
      { files: [{ path: 'src/a.ts', edits: [{ search: 'THIS_DOES_NOT_EXIST', replace: 'x' }] }], rationale: 'bad attempt' },
      { files: [{ path: 'src/a.ts', edits: [{ search: 'bad', replace: 'good' }] }], rationale: 'correct attempt' },
    ]);
    const handle = createFakeEffects(fake, { 'src/a.ts': 'bad' });
    handle.setCheckRuns([checkRun([v1]), checkRun([])]);

    const result = await runAgentLoop(handle.effects, emptyRuleset, opts());

    expect(result.verdict).toBe('done');
    expect(handle.git.commitLog).toHaveLength(1); // only the successful attempt committed
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.previousFailure?.reason).toBe('zero-matches');
  });

  it('escalates after exceeding max REPAIR attempts', async () => {
    const file = toRepoRelativePath('src/a.ts');
    const v1 = violation({ id: 'v1', ruleId: 'arch.no-dependency', file: 'src/a.ts' });
    const fake = new FakeFixProvider();
    fake.script(file, [{ files: [{ path: 'src/a.ts', edits: [{ search: 'NOPE', replace: 'x' }] }], rationale: 'always wrong' }]);
    const handle = createFakeEffects(fake, { 'src/a.ts': 'bad' });
    handle.setCheckRuns([checkRun([v1])]);

    const result = await runAgentLoop(handle.effects, emptyRuleset, opts({ maxAttempts: 2 }));
    expect(result.verdict).toBe('partial-escalated');
    expect(result.groups[0]).toMatchObject({ status: 'escalated' });
    expect((result.groups[0] as { reason: string }).reason).toMatch(/max/i);
  });
});

describe('runAgentLoop — oscillation detection', () => {
  it('stops and escalates naming both rule ids when fix A reintroduces the original violation set', async () => {
    const file = toRepoRelativePath('src/a.ts');
    const vOriginal = violation({ id: 'v-orig', ruleId: 'rule-a', file: 'src/a.ts' });
    const vIntroduced = violation({ id: 'v-b', ruleId: 'rule-b', file: 'src/a.ts' });

    // Violation state in this fake is driven entirely by the scripted CheckRun sequence, not by
    // real static analysis of file content — both edits are harmless self-replacements so APPLY
    // succeeds identically after each REPAIR revert restores the original content.
    const fake = new FakeFixProvider();
    fake.script(file, [
      { files: [{ path: 'src/a.ts', edits: [{ search: 'X', replace: 'X' }] }], rationale: 'fix A, introduces B' },
      { files: [{ path: 'src/a.ts', edits: [{ search: 'X', replace: 'X' }] }], rationale: 'fix B, reintroduces A' },
    ]);
    const handle = createFakeEffects(fake, { 'src/a.ts': 'X' });
    // DISCOVER -> [vOriginal]; after attempt1 commit -> [vIntroduced]; after attempt2 commit -> [vOriginal] again (cycle).
    handle.setCheckRuns([checkRun([vOriginal]), checkRun([vIntroduced]), checkRun([vOriginal])]);

    const result = await runAgentLoop(handle.effects, emptyRuleset, opts({ maxAttempts: 5 }));

    expect(result.verdict).toBe('partial-escalated');
    const g = result.groups[0] as { status: string; reason: string };
    expect(g.status).toBe('escalated');
    expect(g.reason).toMatch(/oscillation/i);
    expect(g.reason).toContain('rule-a');
    expect(g.reason).toContain('rule-b');
    // Both attempts were committed then reverted (oscillation is detected only after a commit).
    expect(handle.git.commitLog).toHaveLength(2);
    expect(handle.git.revertedShas).toHaveLength(2);
  });
});

describe('runAgentLoop — green≠correct guards', () => {
  it('refuses PLAN+FIX on a file with zero test coverage', async () => {
    const file = toRepoRelativePath('src/a.ts');
    const v1 = violation({ id: 'v1', ruleId: 'arch.no-dependency', file: 'src/a.ts' });
    const fake = new FakeFixProvider();
    const handle = createFakeEffects(fake, { 'src/a.ts': 'bad' });
    handle.setGraph(graph([node('src/a.ts', 'core')], [])); // no test file in the graph at all
    handle.setCheckRuns([checkRun([v1])]);

    const result = await runAgentLoop(handle.effects, emptyRuleset, opts({ allowUntested: false }));
    expect(result.groups[0]).toMatchObject({ status: 'escalated' });
    expect((result.groups[0] as { reason: string }).reason).toMatch(/zero test coverage/);
    expect(fake.calls).toHaveLength(0); // never even called the provider
  });

  it('--allow-untested proceeds despite zero coverage', async () => {
    const file = toRepoRelativePath('src/a.ts');
    const v1 = violation({ id: 'v1', ruleId: 'arch.no-dependency', file: 'src/a.ts' });
    const fake = new FakeFixProvider();
    fake.script(file, [{ files: [{ path: 'src/a.ts', edits: [{ search: 'bad', replace: 'good' }] }], rationale: 'fix' }]);
    const handle = createFakeEffects(fake, { 'src/a.ts': 'bad' });
    handle.setGraph(graph([node('src/a.ts', 'core')], []));
    handle.setCheckRuns([checkRun([v1]), checkRun([])]);

    const result = await runAgentLoop(handle.effects, emptyRuleset, opts({ allowUntested: true }));
    expect(result.groups[0]).toMatchObject({ status: 'done' });
  });

  it('escalates on exported-symbol removal unless --allow-symbol-removals is set', async () => {
    const file = toRepoRelativePath('src/a.ts');
    const testFile = toRepoRelativePath('src/a.test.ts');
    const v1 = violation({ id: 'v1', ruleId: 'arch.no-dependency', file: 'src/a.ts' });
    const fake = new FakeFixProvider();
    fake.script(file, [
      { files: [{ path: 'src/a.ts', edits: [{ search: 'export function helper() {}', replace: '' }] }], rationale: 'delete helper' },
    ]);
    const handle = createFakeEffects(fake, { 'src/a.ts': 'export function helper() {}\n', 'src/a.test.ts': 'x' });

    let call = 0;
    const graphs = [
      graph([node('src/a.ts', 'core', ['helper']), node('src/a.test.ts', 'core')], [edge('src/a.test.ts', 'src/a.ts')]),
      graph([node('src/a.ts', 'core', ['helper']), node('src/a.test.ts', 'core')], [edge('src/a.test.ts', 'src/a.ts')]),
      graph([node('src/a.ts', 'core', []), node('src/a.test.ts', 'core')], [edge('src/a.test.ts', 'src/a.ts')]),
    ];
    handle.setGraph(graphs[0] as never);
    const originalScanGraph = handle.effects.scanGraph;
    (handle.effects as { scanGraph: typeof originalScanGraph }).scanGraph = async () => {
      const g = graphs[Math.min(call, graphs.length - 1)] as ReturnType<typeof graph>;
      call += 1;
      return g;
    };
    handle.setCheckRuns([checkRun([v1])]);

    const result = await runAgentLoop(handle.effects, emptyRuleset, opts({ allowSymbolRemovals: false }));
    expect(result.groups[0]).toMatchObject({ status: 'escalated' });
    expect((result.groups[0] as { reason: string }).reason).toMatch(/exported-symbol removal/);
    expect(handle.git.commitLog).toHaveLength(0); // never committed
    expect(handle.fs.get(file)).toBe('export function helper() {}\n'); // reverted to original
    void testFile;
  });
});

describe('runAgentLoop — dry-run', () => {
  it('DISCOVER+GROUP+PLAN only — prints proposed edits without applying or committing', async () => {
    const file = toRepoRelativePath('src/a.ts');
    const v1 = violation({ id: 'v1', ruleId: 'arch.no-dependency', file: 'src/a.ts' });
    const fake = new FakeFixProvider();
    fake.script(file, [{ files: [{ path: 'src/a.ts', edits: [{ search: 'bad', replace: 'good' }] }], rationale: 'fix' }]);
    const handle = createFakeEffects(fake, { 'src/a.ts': 'bad' });
    handle.setCheckRuns([checkRun([v1])]);

    const result = await runAgentLoop(handle.effects, emptyRuleset, opts({ dryRun: true }));
    expect(result.verdict).toBe('dry-run');
    expect(result.groups[0]).toMatchObject({ status: 'dry-run', file });
    expect(handle.fs.get(file)).toBe('bad'); // untouched
    expect(handle.git.commitLog).toHaveLength(0);
  });
});

describe('runAgentLoop — config/`.align` proposal rejection', () => {
  it('escalates a proposal that touches align.config.ts without ever validating an edit against it', async () => {
    const file = toRepoRelativePath('src/a.ts');
    const v1 = violation({ id: 'v1', ruleId: 'arch.no-dependency', file: 'src/a.ts' });
    const fake = new FakeFixProvider();
    fake.script(file, [
      { files: [{ path: 'align.config.ts', edits: [{ search: 'x', replace: 'y' }] }], rationale: 'sneaky' },
    ]);
    const handle = createFakeEffects(fake, { 'src/a.ts': 'bad', 'align.config.ts': 'export default {};' });
    handle.setCheckRuns([checkRun([v1])]);

    const result = await runAgentLoop(handle.effects, emptyRuleset, opts());
    expect(result.groups[0]).toMatchObject({ status: 'escalated' });
    expect((result.groups[0] as { reason: string }).reason).toMatch(/forbidden path/);
  });

  it('escalates a proposal that uses suppressions (dormant machinery, no lint gates active)', async () => {
    const file = toRepoRelativePath('src/a.ts');
    const v1 = violation({ id: 'v1', ruleId: 'arch.no-dependency', file: 'src/a.ts' });
    const fake = new FakeFixProvider();
    fake.script(file, [
      {
        files: [{ path: 'src/a.ts', edits: [{ search: 'bad', replace: 'good' }] }],
        suppressions: [{ ruleId: 'lint.no-console', file: 'src/a.ts', line: 1 }],
        rationale: 'suppress instead of fix',
      },
    ]);
    const handle = createFakeEffects(fake, { 'src/a.ts': 'bad' });
    handle.setCheckRuns([checkRun([v1])]);

    const result = await runAgentLoop(handle.effects, emptyRuleset, opts());
    expect(result.groups[0]).toMatchObject({ status: 'escalated' });
    expect((result.groups[0] as { reason: string }).reason).toMatch(/no suppressible rule categories/);
  });
});

describe('defaultWorkBranchName', () => {
  it('formats as align/fixes-<YYYY-MM-DD>', () => {
    const fixed = () => new Date('2026-07-12T00:00:00Z').getTime();
    expect(defaultWorkBranchName(fixed)).toBe('align/fixes-2026-07-12');
  });
});
