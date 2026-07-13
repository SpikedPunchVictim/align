/**
 * `align agent run` — the CLI composition root for the Stage 4 BYOK fix loop. Mirrors
 * `composition-root.ts`'s discipline: `@spikedpunch/align-agent` never imports `@spikedpunch/align-plugin-typescript` or
 * touches the filesystem/git directly (per its stated dependency budget, `@spikedpunch/align-core` +
 * `@anthropic-ai/sdk`); this file is the only place that wires the real `TypeScriptPlugin` scanner,
 * `node:fs`, and real git into `AgentEffects`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toRepoRelativePath, type HostPredicateRegistry, type RepoRelativePath } from '@spikedpunch/align-core';
import { TypeScriptPlugin } from '@spikedpunch/align-plugin-typescript';
import {
  AnthropicFixProvider,
  MemoizingFixProvider,
  createNodeGitEffects,
  defaultWorkBranchName,
  formatIfAvailable,
  runAgentLoop,
  type AgentEffects,
  type AgentRunOptions,
  type AgentRunResult,
} from '@spikedpunch/align-agent';
import { loadConfig } from '../config.js';
import { createOrchestrator } from '../composition-root.js';
import { readBaseline } from '../align-dir.js';

export interface AgentRunCliOptions {
  readonly maxAttempts: number;
  readonly pr: boolean;
  readonly autoMerge: boolean;
  readonly allowUntested: boolean;
  readonly allowSymbolRemovals: boolean;
  readonly model?: string;
  readonly dryRun: boolean;
}

function buildEffects(
  rootDir: string,
  ruleset: Awaited<ReturnType<typeof loadConfig>>['ruleset'],
  excludes: readonly string[],
  hostRules: HostPredicateRegistry,
  options: AgentRunCliOptions,
): AgentEffects {
  const plugin = new TypeScriptPlugin();
  return {
    fixProvider: new MemoizingFixProvider(
      options.model !== undefined ? new AnthropicFixProvider({ model: options.model }) : new AnthropicFixProvider(),
    ),
    runCheck: async () => {
      const { orchestrator } = createOrchestrator(ruleset, readBaseline(rootDir), hostRules);
      return orchestrator.check({ rootDir, excludes });
    },
    scanGraph: () => plugin.scanner.scan({ rootDir, components: ruleset.components, excludes }),
    readFile: async (p: RepoRelativePath) => fs.readFileSync(path.join(rootDir, p), 'utf8'),
    writeFile: async (p: RepoRelativePath, content: string) => {
      fs.mkdirSync(path.dirname(path.join(rootDir, p)), { recursive: true });
      fs.writeFileSync(path.join(rootDir, p), content, 'utf8');
    },
    formatIfAvailable: (paths: readonly RepoRelativePath[]) => formatIfAvailable(rootDir, paths),
    git: createNodeGitEffects(rootDir),
    now: () => Date.now(),
  };
}

function printResult(result: AgentRunResult): void {
  console.log(`align agent run — verdict: ${result.verdict}`);
  if (result.refusalReason !== undefined) console.log(`  refused: ${result.refusalReason}`);

  for (const g of result.groups) {
    if (g.status === 'done') {
      console.log(`  DONE       ${g.file}  (${g.commitSha.slice(0, 7)}) ${g.rationale}`);
    } else if (g.status === 'escalated') {
      console.log(`  ESCALATED  ${g.file}  ${g.reason}`);
    } else {
      console.log(`  DRY-RUN    ${g.file}`);
      for (const f of g.proposal.files) {
        console.log(`    file: ${f.path}`);
        for (const e of f.edits) {
          console.log(`      search:  ${JSON.stringify(e.search)}`);
          console.log(`      replace: ${JSON.stringify(e.replace)}`);
        }
      }
      console.log(`    rationale: ${g.proposal.rationale}`);
    }
  }

  const tm = result.terminalMerge;
  if (tm !== undefined) {
    switch (tm.status) {
      case 'pr-created':
        console.log(`  PR opened: ${tm.url}`);
        break;
      case 'no-remote-or-no-gh':
        console.log(`  No remote/gh available — branch left in place: ${tm.branch}\n${tm.summary}`);
        break;
      case 'auto-merged':
        console.log('  Auto-merged into the base branch; work branch deleted.');
        break;
      case 'rebase-conflict':
        console.log('  TERMINAL MERGE escalated: rebase conflict — never auto-resolved. Resolve manually on the work branch.');
        break;
      case 'final-check-red':
        console.log('  TERMINAL MERGE escalated: the FULL check is red on the rebased tip — investigate before merging.');
        break;
      case 'no-commits':
        console.log('  No group reached DONE — nothing to merge.');
        break;
    }
  }
}

function exitCodeFor(result: AgentRunResult): number {
  if (result.verdict === 'refused' || result.verdict === 'partial-escalated') return 1;
  if (result.verdict === 'done') {
    const tm = result.terminalMerge;
    if (tm?.status === 'rebase-conflict' || tm?.status === 'final-check-red') return 1;
    return 0;
  }
  return 0; // nothing-to-fix / dry-run
}

export async function runAgentCommand(rootDir: string, options: AgentRunCliOptions): Promise<number> {
  const { ruleset, excludes, hostRules } = await loadConfig(rootDir);
  const effects = buildEffects(rootDir, ruleset, excludes, hostRules, options);

  const baseBranch = await effects.git.currentBranch();
  const runOptions: AgentRunOptions = {
    maxAttempts: options.maxAttempts,
    mode: options.autoMerge ? 'auto-merge' : 'pr',
    allowUntested: options.allowUntested,
    allowSymbolRemovals: options.allowSymbolRemovals,
    dryRun: options.dryRun,
    workBranchName: defaultWorkBranchName(),
    baseBranch,
  };

  const result = await runAgentLoop(effects, ruleset, runOptions);
  printResult(result);
  return exitCodeFor(result);
}

// Re-exported so tests/CLI wiring can construct a RepoRelativePath without importing @spikedpunch/align-core
// directly in every call site.
export { toRepoRelativePath };
