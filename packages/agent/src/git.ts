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

export function createNodeGitEffects(rootDir: string): GitEffects {
  return {
    async isWorktreeClean(): Promise<boolean> {
      const { stdout } = await git(rootDir, ['status', '--porcelain']);
      return stdout.trim().length === 0;
    },

    async currentBranch(): Promise<string> {
      const { stdout } = await git(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      return stdout.trim();
    },

    async createBranch(name: string): Promise<void> {
      await git(rootDir, ['checkout', '-b', name]);
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
