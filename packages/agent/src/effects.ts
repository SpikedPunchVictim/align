/**
 * Injected effects — the imperative shell the state machine (`run.ts`) is built against. Every
 * side effect (fs, git, `align check`, formatting) is an interface here so the state machine can
 * be driven end-to-end by a fake in tests, per CODING_BEST_PRACTICES.md §15 ("if you're reaching
 * for module mocking, the dependency wasn't injected").
 */
import type { CheckRun, DependencyGraph, RepoRelativePath } from '@spikedpunch/align-core';
import type { FixProvider } from './fixProvider.js';

export interface GitCommitResult {
  readonly sha: string;
}

export type RebaseResult = { readonly ok: true } | { readonly ok: false; readonly conflict: true };

export type PushResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'no-remote' | 'push-failed' };

export type PrResult = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

/** All git operations the agent needs — a thin, testable seam over the real `git`/`gh` binaries. */
export interface GitEffects {
  isWorktreeClean(): Promise<boolean>;
  currentBranch(): Promise<string>;
  createBranch(name: string): Promise<void>;
  /** Stages exactly `paths` and commits. Returns the new commit sha. */
  commit(message: string, paths: readonly RepoRelativePath[]): Promise<GitCommitResult>;
  /** Hard-reverts the working tree to the state before `sha` (used by REPAIR). */
  revertCommit(sha: string): Promise<void>;
  /** Rebases the current branch onto `ontoBranch`. Never auto-resolves conflicts. */
  rebaseOnto(ontoBranch: string): Promise<RebaseResult>;
  push(branch: string): Promise<PushResult>;
  /** Requires `gh` on PATH and a remote; returns `ok:false` (never throws) when either is absent. */
  createDraftPr(params: { readonly branch: string; readonly base: string; readonly title: string; readonly body: string }): Promise<PrResult>;
  ffMergeAndDeleteBranch(branch: string, base: string): Promise<void>;
}

export interface AgentEffects {
  readonly fixProvider: FixProvider;
  /** Fresh, FULL `align check` — no scoping (DISCOVER and the terminal-merge verify both use this;
   * VERIFY inside the loop uses it too — v1 keeps verification uniformly full-scope, matching
   * ADR 005's "the oracle never answers from state older than the code it judges" doctrine and
   * sidestepping impact-scoping, which is Design Reserve). */
  readonly runCheck: () => Promise<CheckRun>;
  /** Fresh full dependency-graph scan (for condensedSymbolTable, coverage heuristic, symbol diff). */
  readonly scanGraph: () => Promise<DependencyGraph>;
  readonly readFile: (path: RepoRelativePath) => Promise<string>;
  readonly writeFile: (path: RepoRelativePath, content: string) => Promise<void>;
  /** Mechanical post-format: runs the target repo's own prettier on `paths` if the target repo
   * exposes one (checked via its own package.json/devDependencies); skips silently otherwise. */
  readonly formatIfAvailable: (paths: readonly RepoRelativePath[]) => Promise<void>;
  readonly git: GitEffects;
  readonly now: () => number;
}
