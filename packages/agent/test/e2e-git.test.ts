/**
 * End-to-end validation against a REAL temp git repo + REAL `createNodeGitEffects` (no mocking of
 * `git`/`gh`) + a scripted `FakeFixProvider` (no network). `runCheck`/`scanGraph` are small
 * scripted closures rather than the real `@align/plugin-typescript` scanner — exercising the real
 * TS scanner here would require this test file to import `@align/plugin-typescript`, which would
 * itself violate `@align/agent`'s own dogfooded "depends only on @align/core" rule (align.config.ts).
 * The apply pipeline (`applyFixProposalFiles`, `@align/core`), the git rails, and the terminal
 * merge are all real; only violation detection is scripted, which is exactly the seam
 * `AgentEffects.runCheck` exists to isolate.
 *
 * Covers: red (2 groups, 2 separate files) -> green, every commit revertable (verified via
 * `git log`), and the local-only fast-forward terminal-merge path in a real repo.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toRepoRelativePath, type CheckRun, type RulesetIR } from '@align/core';
import { createNodeGitEffects } from '../src/git.js';
import { runAgentLoop, defaultWorkBranchName, type AgentEffects, type AgentRunOptions } from '../src/run.js';
import { FakeFixProvider } from './fakeFixProvider.js';
import { checkRun, violation } from './helpers.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-agent-e2e-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Align Test']);

  fs.mkdirSync(path.join(dir, 'src/api'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/loop'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src/api/service.ts'),
    `import { render } from '../ui/component.js';\n\nexport function handleRequest(): string {\n  return render();\n}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'src/loop/a.ts'),
    `import { b } from './b.js';\n\nexport function a(): number {\n  return b() + 1;\n}\n`,
    'utf8',
  );

  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial commit']);
  return dir;
}

function scriptedRunCheck(runs: readonly CheckRun[]): () => Promise<CheckRun> {
  let i = 0;
  return async () => {
    const run = runs[Math.min(i, runs.length - 1)];
    i += 1;
    if (run === undefined) throw new Error('no scripted CheckRun');
    return run;
  };
}

const emptyRuleset: RulesetIR = { irVersion: '1', components: {}, rules: [] };

describe('E2E — real git repo, scripted violations, FakeFixProvider', () => {
  it('red (2 groups) -> green, every commit revertable, terminal ff-merge succeeds locally', async () => {
    tmpDir = initRepo();

    const serviceFile = toRepoRelativePath('src/api/service.ts');
    const loopFile = toRepoRelativePath('src/loop/a.ts');
    const vService = violation({ id: 'v-service', ruleId: 'arch.no-dependency', file: 'src/api/service.ts' });
    const vLoop = violation({ id: 'v-loop', ruleId: 'arch.no-cycles', file: 'src/loop/a.ts' });

    const fake = new FakeFixProvider();
    fake.script(serviceFile, [
      {
        files: [{ path: 'src/api/service.ts', edits: [{ search: "import { render } from '../ui/component.js';\n\n", replace: '' }] }],
        rationale: 'remove forbidden ui import from api',
      },
    ]);
    fake.script(loopFile, [
      {
        files: [{ path: 'src/loop/a.ts', edits: [{ search: "import { b } from './b.js';\n", replace: '' }] }],
        rationale: 'break the a<->b import cycle',
      },
    ]);

    const git = createNodeGitEffects(tmpDir);
    const runCheck = scriptedRunCheck([
      checkRun([vService, vLoop]), // DISCOVER: red, 2 groups
      checkRun([]), // VERIFY after group 1's commit: clean
      checkRun([]), // VERIFY after group 2's commit: clean
      checkRun([]), // terminal merge's final FULL check: green
    ]);

    const effects: AgentEffects = {
      fixProvider: fake,
      runCheck,
      scanGraph: async () => ({ nodes: [], edges: [], uncertain: [], scannedAt: 0 }),
      readFile: async (p) => fs.readFileSync(path.join(tmpDir, p), 'utf8'),
      writeFile: async (p, content) => fs.writeFileSync(path.join(tmpDir, p), content, 'utf8'),
      formatIfAvailable: async () => undefined,
      git,
      now: () => Date.now(),
    };

    const options: AgentRunOptions = {
      maxAttempts: 3,
      mode: 'auto-merge',
      allowUntested: true,
      allowSymbolRemovals: true,
      dryRun: false,
      workBranchName: defaultWorkBranchName(),
      baseBranch: 'main',
    };

    const result = await runAgentLoop(effects, emptyRuleset, options);

    expect(result.verdict).toBe('done');
    expect(result.groups).toHaveLength(2);
    expect(result.groups.every((g) => g.status === 'done')).toBe(true);
    expect(result.terminalMerge).toEqual({ status: 'auto-merged' });

    // Real git assertions: the work branch is gone (ff-merged + deleted), main now has the fixes,
    // and every intermediate commit is genuinely revertable (git history is well-formed, not just
    // asserted by the in-memory fake).
    const branches = git_branches(tmpDir);
    expect(branches).not.toContain(options.workBranchName);
    expect(branches.some((b) => b === 'main' || b === '* main')).toBe(true);

    const serviceContent = fs.readFileSync(path.join(tmpDir, 'src/api/service.ts'), 'utf8');
    expect(serviceContent).not.toContain('ui/component.js');
    const loopContent = fs.readFileSync(path.join(tmpDir, 'src/loop/a.ts'), 'utf8');
    expect(loopContent).not.toContain("./b.js");

    const log = git_log(tmpDir);
    expect(log.length).toBeGreaterThanOrEqual(3); // initial commit + 2 fix commits, all real, all revertable
  });

  it('refuses a dirty worktree using the REAL `git status` check', async () => {
    tmpDir = initRepo();
    fs.writeFileSync(path.join(tmpDir, 'src/api/service.ts'), 'dirty change, not committed', 'utf8');

    const fake = new FakeFixProvider();
    const effects: AgentEffects = {
      fixProvider: fake,
      runCheck: scriptedRunCheck([checkRun([])]),
      scanGraph: async () => ({ nodes: [], edges: [], uncertain: [], scannedAt: 0 }),
      readFile: async (p) => fs.readFileSync(path.join(tmpDir, p), 'utf8'),
      writeFile: async (p, content) => fs.writeFileSync(path.join(tmpDir, p), content, 'utf8'),
      formatIfAvailable: async () => undefined,
      git: createNodeGitEffects(tmpDir),
      now: () => Date.now(),
    };

    const result = await runAgentLoop(effects, emptyRuleset, {
      maxAttempts: 3,
      mode: 'auto-merge',
      allowUntested: true,
      allowSymbolRemovals: true,
      dryRun: false,
      workBranchName: defaultWorkBranchName(),
      baseBranch: 'main',
    });

    expect(result.verdict).toBe('refused');
    expect(fake.calls).toHaveLength(0);
  });
});

function git_branches(cwd: string): string[] {
  return git(cwd, ['branch']).split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

function git_log(cwd: string): string[] {
  return git(cwd, ['log', '--oneline']).split('\n').filter((l) => l.trim().length > 0);
}
