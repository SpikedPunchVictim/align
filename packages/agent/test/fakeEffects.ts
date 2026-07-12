/**
 * In-memory `AgentEffects` fake for state-machine tests — no real git, no real filesystem, no
 * network. `FakeGitEffects` simulates real git revert semantics (undo-log per commit) so REPAIR
 * tests that write, commit, then revert see the file content actually restored — matching what
 * `git reset --hard <sha>~1` does for real.
 */
import type { CheckRun, DependencyGraph, RepoRelativePath } from '@align/core';
import type { AgentEffects, GitCommitResult, GitEffects, PrResult, PushResult, RebaseResult } from '../src/effects.js';
import type { FixProvider } from '../src/fixProvider.js';

interface UndoEntry {
  readonly path: RepoRelativePath;
  readonly previous: string | undefined;
}

export class FakeGitEffects implements GitEffects {
  public clean = true;
  public branch = 'main';
  public rebaseShouldConflict = false;
  public pushShouldSucceed = true;
  public ghAvailable = true;
  public prUrl = 'https://example.com/pr/1';
  public readonly commitLog: { sha: string; message: string; paths: readonly RepoRelativePath[] }[] = [];
  public readonly revertedShas: string[] = [];
  public ffMerged = false;
  public deletedBranch: string | undefined;

  private pendingUndo: UndoEntry[] = [];
  private readonly commitUndo = new Map<string, UndoEntry[]>();
  private commitCounter = 0;

  constructor(private readonly fs: Map<RepoRelativePath, string>) {}

  /** Called by the fake `writeFile` effect right before mutating `fs`, so a later `revertCommit`
   * can restore exactly what was overwritten by this attempt's writes. */
  recordWrite(path: RepoRelativePath, previous: string | undefined): void {
    this.pendingUndo.push({ path, previous });
  }

  async isWorktreeClean(): Promise<boolean> {
    return this.clean;
  }
  async currentBranch(): Promise<string> {
    return this.branch;
  }
  async createBranch(name: string): Promise<void> {
    this.branch = name;
  }
  async commit(message: string, paths: readonly RepoRelativePath[]): Promise<GitCommitResult> {
    this.commitCounter += 1;
    const sha = `sha-${this.commitCounter}`;
    this.commitUndo.set(sha, this.pendingUndo);
    this.pendingUndo = [];
    this.commitLog.push({ sha, message, paths });
    return { sha };
  }
  async revertCommit(sha: string): Promise<void> {
    this.revertedShas.push(sha);
    const undo = this.commitUndo.get(sha);
    if (undo === undefined) return;
    for (const entry of [...undo].reverse()) {
      if (entry.previous === undefined) this.fs.delete(entry.path);
      else this.fs.set(entry.path, entry.previous);
    }
    this.commitUndo.delete(sha);
  }
  async rebaseOnto(): Promise<RebaseResult> {
    return this.rebaseShouldConflict ? { ok: false, conflict: true } : { ok: true };
  }
  async push(): Promise<PushResult> {
    return this.pushShouldSucceed ? { ok: true } : { ok: false, reason: 'no-remote' };
  }
  async createDraftPr(): Promise<PrResult> {
    return this.ghAvailable ? { ok: true, url: this.prUrl } : { ok: false, reason: 'gh CLI not found on PATH' };
  }
  async ffMergeAndDeleteBranch(branch: string): Promise<void> {
    this.ffMerged = true;
    this.deletedBranch = branch;
  }
}

export interface FakeEffectsHandle {
  readonly effects: AgentEffects;
  readonly git: FakeGitEffects;
  readonly fs: Map<RepoRelativePath, string>;
  setGraph(graph: DependencyGraph): void;
  setCheckRuns(runs: readonly CheckRun[]): void; // consumed in order, last one repeats
  readonly formatCalls: RepoRelativePath[][];
}

export function createFakeEffects(fixProvider: FixProvider, initialFiles: Record<string, string>): FakeEffectsHandle {
  const fs = new Map<RepoRelativePath, string>(Object.entries(initialFiles) as [RepoRelativePath, string][]);
  const git = new FakeGitEffects(fs);
  let graph: DependencyGraph = { nodes: [], edges: [], uncertain: [], scannedAt: 0 };
  let checkRuns: CheckRun[] = [];
  let checkIndex = 0;
  const formatCalls: RepoRelativePath[][] = [];

  const effects: AgentEffects = {
    fixProvider,
    async runCheck(): Promise<CheckRun> {
      const run = checkRuns[Math.min(checkIndex, checkRuns.length - 1)];
      checkIndex += 1;
      if (run === undefined) throw new Error('FakeEffects: no scripted CheckRun');
      return run;
    },
    async scanGraph(): Promise<DependencyGraph> {
      return graph;
    },
    async readFile(path: RepoRelativePath): Promise<string> {
      const content = fs.get(path);
      if (content === undefined) throw new Error(`FakeEffects: no file at ${path}`);
      return content;
    },
    async writeFile(path: RepoRelativePath, content: string): Promise<void> {
      git.recordWrite(path, fs.get(path));
      fs.set(path, content);
    },
    async formatIfAvailable(paths: readonly RepoRelativePath[]): Promise<void> {
      formatCalls.push([...paths]);
    },
    git,
    now: () => 0,
  };

  return {
    effects,
    git,
    fs,
    setGraph: (g) => {
      graph = g;
    },
    setCheckRuns: (runs) => {
      checkRuns = [...runs];
      checkIndex = 0;
    },
    formatCalls,
  };
}
