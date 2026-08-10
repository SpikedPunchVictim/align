/**
 * Real `git`/`gh` implementation of `GitEffects` — the only place in `@spikedpunch/align-agent` that shells
 * out. No git library dependency exists anywhere else in this monorepo (confirmed at Stage-4
 * research time), so this is net-new plumbing: thin wrappers over `git`/`gh` via
 * `node:child_process`, never a shell string (execFile, not exec — no shell-injection surface
 * from LLM-controlled commit messages/branch names).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitCommitResult, GitEffects, PrResult, PushResult, RebaseResult } from './effects.js';

const execFileAsync = promisify(execFile);

async function git(rootDir: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', [...args], { cwd: rootDir, maxBuffer: 32 * 1024 * 1024 });
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(cmd, ['--version']);
    return true;
  } catch {
    return false;
  }
}

async function currentBranchOf(rootDir: string): Promise<string> {
  const { stdout } = await git(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}

export function createNodeGitEffects(rootDir: string): GitEffects {
  return {
    async isWorktreeClean(): Promise<boolean> {
      const { stdout } = await git(rootDir, ['status', '--porcelain']);
      return stdout.trim().length === 0;
    },

    async currentBranch(): Promise<string> {
      return currentBranchOf(rootDir);
    },

    async createBranch(name: string): Promise<void> {
      try {
        await git(rootDir, ['checkout', '-b', name]);
        return;
      } catch {
        // Branch already exists — most commonly a prior `align agent run` the same day
        // (`defaultWorkBranchName` is date-granular, bug hunt 2026-08-03 BUG #13). Resume onto it
        // rather than creating a second one. NEVER swallow this and let the caller proceed on
        // whatever branch it started on — `runAgentLoop` commits LLM-authored changes right after
        // this call, and doing that on `main` is not recoverable by re-running.
        await git(rootDir, ['checkout', name]);
      }
      // Post-condition, not an exit-code inference: assert the tree is actually on `name` before
      // returning success. A silently-successful `checkout -b`/`checkout` that somehow leaves HEAD
      // elsewhere (detached HEAD, a hook redirecting the checkout, etc.) must fail loudly here
      // rather than let the caller assume it's safe to commit.
      const current = await currentBranchOf(rootDir);
      if (current !== name) {
        throw new Error(
          `align agent could not switch to work branch '${name}' (still on '${current}'). Refusing ` +
            `to continue — every apply must land on the work branch, never on your current branch.`,
        );
      }
    },

    async commit(message: string, paths: readonly RepoRelativePathLike[]): Promise<GitCommitResult> {
      if (paths.length === 0) throw new Error('commit() requires at least one path');
      await git(rootDir, ['add', '--', ...paths]);
      await git(rootDir, ['commit', '-m', message]);
      const { stdout } = await git(rootDir, ['rev-parse', 'HEAD']);
      return { sha: stdout.trim() };
    },

    async revertCommit(sha: string): Promise<void> {
      // Work-branch commits are throwaway per REPAIR attempt — a hard reset to the commit's
      // parent is the git-native "undo," not a revert-commit (no noise commits on a branch that
      // may itself be discarded on escalation).
      await git(rootDir, ['reset', '--hard', `${sha}~1`]);
    },

    async rebaseOnto(ontoBranch: string): Promise<RebaseResult> {
      try {
        await git(rootDir, ['rebase', ontoBranch]);
        return { ok: true };
      } catch {
        await git(rootDir, ['rebase', '--abort']).catch(() => undefined);
        return { ok: false, conflict: true };
      }
    },

    async push(branch: string): Promise<PushResult> {
      const { stdout } = await git(rootDir, ['remote']);
      if (stdout.trim().length === 0) return { ok: false, reason: 'no-remote' };
      try {
        await git(rootDir, ['push', '-u', 'origin', branch]);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'push-failed' };
      }
    },

    async createDraftPr(params): Promise<PrResult> {
      if (!(await commandExists('gh'))) {
        return { ok: false, reason: 'gh CLI not found on PATH' };
      }
      try {
        const { stdout } = await execFileAsync(
          'gh',
          ['pr', 'create', '--draft', '--base', params.base, '--head', params.branch, '--title', params.title, '--body', params.body],
          { cwd: rootDir },
        );
        return { ok: true, url: stdout.trim() };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async ffMergeAndDeleteBranch(branch: string, base: string): Promise<void> {
      await git(rootDir, ['checkout', base]);
      await git(rootDir, ['merge', '--ff-only', branch]);
      await git(rootDir, ['branch', '-d', branch]);
    },
  };
}

// `paths` arrive as branded RepoRelativePath[] at call sites but git() only needs plain strings.
type RepoRelativePathLike = string;

/**
 * Test-support helper: initializes `dir` as a fresh git repo with one commit containing everything
 * currently in it (`git init` + `config user.*` + `add -A` + `commit`). Exists so tests ACROSS
 * packages that need a real repo to exercise real git-backed behavior — this package's own
 * `test/e2e-git.test.ts`, and `@spikedpunch/align-cli`'s transform/upgrade tests that need a real
 * working tree to check `isWorktreeClean()` against — share ONE audited git shell-out rather than
 * each duplicating raw `child_process` calls. This file (`git.ts`) is already align's one audited,
 * execFile-only git rails file (this module's own doc comment); adding this here means no OTHER
 * file, in this package or any consumer, ever needs its own `node:child_process` import just to
 * bootstrap a test repo — `@spikedpunch/align-cli`'s `cannotDependOn(external('node:child_process'))`
 * rule (align.config.ts, ADR 017 Part A) stays intact rather than needing a test-file carve-out.
 *
 * NOT part of `GitEffects` — that interface models operating on an EXISTING user repo
 * (`align agent run` never creates one), so `init` has no place there. This is deliberately a
 * free function, not a method, for exactly that reason.
 */
export async function initTestGitRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Align Test']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'initial commit']);
}
