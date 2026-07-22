/**
 * The imperative shell (CODING_BEST_PRACTICES.md §14) that drives one `align agent run`:
 * DISCOVER -> GROUP -> PLAN+FIX -> APPLY -> VERIFY -> REPAIR -> ESCALATE -> DONE -> TERMINAL MERGE.
 * All I/O goes through `AgentEffects`; all decisions with real branching logic are pure functions
 * imported from `repairDecision.ts`/`oscillation.ts`/`rails.ts`/`coverage.ts`/`symbolDiff.ts` —
 * this file is deliberately thin sequencing, testable end-to-end with a fake `AgentEffects` +
 * `FakeFixProvider` (see `test/run.test.ts`), never mocking a module.
 */
import {
  applyFixProposalFiles,
  toRepoRelativePath,
  toRuleId,
  type CheckRun,
  type FailureContext,
  type FixProposal,
  type RepoRelativePath,
  type RuleId,
  type RulesetIR,
  type Violation,
} from '@spikedpunch/align-core';
import type { AgentEffects } from './effects.js';
import type { FixProviderInput, RuleExplanation } from './fixProvider.js';
import { buildCondensedSymbolTable } from './symbolTable.js';
import { isFileCovered } from './coverage.js';
import { diffExportedSymbols } from './symbolDiff.js';
import { decideNextRepairAction, type RepairDecision } from './repairDecision.js';
import { detectOscillation, type AttemptFingerprint } from './oscillation.js';
import { findForbiddenPathsInProposal, groupViolationsByFile, usesSuppressions } from './rails.js';

export interface AgentRunOptions {
  readonly maxAttempts: number;
  readonly mode: 'pr' | 'auto-merge';
  readonly allowUntested: boolean;
  readonly allowSymbolRemovals: boolean;
  readonly dryRun: boolean;
  readonly workBranchName: string;
  readonly baseBranch: string;
  readonly prTitle?: string;
}

export type GroupOutcome =
  | { readonly status: 'done'; readonly file: RepoRelativePath; readonly commitSha: string; readonly rationale: string }
  | { readonly status: 'escalated'; readonly file: RepoRelativePath; readonly reason: string }
  | { readonly status: 'dry-run'; readonly file: RepoRelativePath; readonly proposal: FixProposal };

export type TerminalMergeOutcome =
  | { readonly status: 'no-commits' }
  | { readonly status: 'rebase-conflict' }
  | { readonly status: 'final-check-red'; readonly finalCheck: CheckRun }
  | { readonly status: 'auto-merged' }
  | { readonly status: 'pr-created'; readonly url: string; readonly summary: string }
  | { readonly status: 'no-remote-or-no-gh'; readonly summary: string; readonly branch: string };

export type AgentRunVerdict = 'refused' | 'nothing-to-fix' | 'dry-run' | 'done' | 'partial-escalated';

export interface AgentRunResult {
  readonly verdict: AgentRunVerdict;
  readonly refusalReason?: string;
  readonly groups: readonly GroupOutcome[];
  readonly finalCheck?: CheckRun;
  readonly terminalMerge?: TerminalMergeOutcome;
}

function ruleExplanationMap(ruleset: RulesetIR): Map<RuleId, RuleExplanation> {
  const map = new Map<RuleId, RuleExplanation>();
  for (const rule of ruleset.rules) {
    const because = rule.provenance.because ?? rule.provenance.sourceQuote;
    const ruleId = toRuleId(rule.id);
    map.set(ruleId, because === undefined ? { ruleId, kind: rule.kind } : { ruleId, kind: rule.kind, because });
  }
  return map;
}

function explanationsFor(violations: readonly Violation[], map: ReadonlyMap<RuleId, RuleExplanation>): readonly RuleExplanation[] {
  const ids = [...new Set(violations.map((v) => v.ruleId))];
  return ids.map((id) => map.get(id) ?? { ruleId: id, kind: 'unknown' });
}

function fingerprintOf(violations: readonly Violation[]): AttemptFingerprint {
  return { violationIds: new Set(violations.map((v) => v.id)), ruleIds: new Set(violations.map((v) => v.ruleId)) };
}

function escalationFromDecision(decision: RepairDecision): string {
  if (decision.action === 'escalate-oscillation') {
    return `oscillation detected — conflicting rules: ${decision.conflictingRuleIds.join(', ')} (fix A introduced B, fix B reintroduced A)`;
  }
  return 'exceeded the maximum REPAIR attempts for this group';
}

async function buildInputForFile(
  effects: AgentEffects,
  file: RepoRelativePath,
  violations: readonly Violation[],
  explanations: ReadonlyMap<RuleId, RuleExplanation>,
  previousFailure?: FailureContext,
): Promise<FixProviderInput> {
  const graph = await effects.scanGraph();
  const fileContent = await effects.readFile(file);
  return {
    violations,
    fileContents: new Map([[file, fileContent]]),
    condensedSymbolTable: buildCondensedSymbolTable(file, graph),
    ruleExplanations: explanationsFor(violations, explanations),
    ...(previousFailure !== undefined ? { previousFailure } : {}),
  };
}

/** DISCOVER + GROUP + PLAN only — used both for `--dry-run` and internally is NOT reused for the
 * real run (the real run needs the full per-group loop below, not just one proposal). */
async function planOnly(
  effects: AgentEffects,
  groupsMap: ReadonlyMap<RepoRelativePath, readonly Violation[]>,
  explanations: ReadonlyMap<RuleId, RuleExplanation>,
): Promise<readonly GroupOutcome[]> {
  const outcomes: GroupOutcome[] = [];
  for (const [file, violations] of groupsMap) {
    const input = await buildInputForFile(effects, file, violations, explanations);
    const proposal = await effects.fixProvider.proposeFix(input);
    outcomes.push({ status: 'dry-run', file, proposal });
  }
  return outcomes;
}

/** PLAN+FIX -> APPLY -> VERIFY -> REPAIR for one file GROUP. Returns once the group reaches DONE
 * or ESCALATE. */
async function runGroup(
  effects: AgentEffects,
  file: RepoRelativePath,
  initialViolations: readonly Violation[],
  explanations: ReadonlyMap<RuleId, RuleExplanation>,
  options: AgentRunOptions,
): Promise<GroupOutcome> {
  // Green≠correct guard (b): zero-coverage refusal — checked once, before any PLAN+FIX call.
  if (!options.allowUntested) {
    const graph = await effects.scanGraph();
    if (!isFileCovered(file, graph)) {
      return {
        status: 'escalated',
        file,
        reason: 'zero test coverage — no scanned test file transitively imports this file (pass --allow-untested to override)',
      };
    }
  }

  const history: AttemptFingerprint[] = [fingerprintOf(initialViolations)];
  let attemptsSoFar = 0;
  let currentViolations = initialViolations;
  let previousFailure: FailureContext | undefined;

  for (;;) {
    const input = await buildInputForFile(effects, file, currentViolations, explanations, previousFailure);
    const proposal = await effects.fixProvider.proposeFix(input);

    const forbidden = findForbiddenPathsInProposal(proposal);
    if (forbidden.length > 0) {
      return { status: 'escalated', file, reason: `proposal touched a forbidden path: ${forbidden.map((f) => f.path).join(', ')}` };
    }
    if (usesSuppressions(proposal)) {
      return { status: 'escalated', file, reason: 'no suppressible rule categories active — suppressions field is dormant in v1' };
    }

    const originals = new Map<RepoRelativePath, string>();
    for (const f of proposal.files) {
      const p = toRepoRelativePath(f.path);
      originals.set(p, await effects.readFile(p));
    }
    const validated = applyFixProposalFiles(originals, proposal.files, toRepoRelativePath);
    const applyFailure = validated.find((v) => !v.ok);

    if (applyFailure !== undefined && !applyFailure.ok) {
      attemptsSoFar += 1;
      const decision = decideNextRepairAction(history, attemptsSoFar, options.maxAttempts);
      if (decision.action !== 'retry') return { status: 'escalated', file, reason: escalationFromDecision(decision) };
      previousFailure = applyFailure.failure;
      continue;
    }

    const touchedPaths = validated.filter((v): v is Extract<typeof v, { ok: true }> => v.ok).map((v) => v.path);
    const graphBefore = await effects.scanGraph();
    for (const v of validated) if (v.ok) await effects.writeFile(v.path, v.content);
    await effects.formatIfAvailable(touchedPaths);

    // Green≠correct guard (a): exported-symbol surface diff.
    const graphAfter = await effects.scanGraph();
    const before = touchedPaths.map((p) => ({ file: p, exports: graphBefore.nodes.find((n) => n.file === p)?.exports ?? [] }));
    const after = touchedPaths.map((p) => ({ file: p, exports: graphAfter.nodes.find((n) => n.file === p)?.exports ?? [] }));
    const removals = diffExportedSymbols(before, after);
    if (removals.length > 0 && !options.allowSymbolRemovals) {
      for (const [p, content] of originals) await effects.writeFile(p, content); // revert uncommitted writes
      return {
        status: 'escalated',
        file,
        reason: `exported-symbol removal requires --allow-symbol-removals: ${removals.map((r) => `${r.file}(${r.removedSymbols.join(',')})`).join('; ')}`,
      };
    }

    const { sha } = await effects.git.commit(proposal.rationale, touchedPaths);

    const checkRun = await effects.runCheck();
    if (checkRun.verdict === 'error') {
      return { status: 'escalated', file, reason: 'gate error during VERIFY — environmental, halting this group' };
    }

    const remaining = checkRun.gates.flatMap((g) => g.violations).filter((v) => touchedPaths.includes(v.file));
    if (remaining.length === 0) {
      return { status: 'done', file, commitSha: sha, rationale: proposal.rationale };
    }

    history.push(fingerprintOf(remaining));
    attemptsSoFar += 1;
    const decision = decideNextRepairAction(history, attemptsSoFar, options.maxAttempts);
    await effects.git.revertCommit(sha);
    if (decision.action !== 'retry') return { status: 'escalated', file, reason: escalationFromDecision(decision) };

    currentViolations = remaining;
    previousFailure = undefined; // a "still red" retry is not an apply-mismatch retry
  }
}

function renderPrSummary(doneGroups: readonly Extract<GroupOutcome, { status: 'done' }>[]): string {
  const lines = ['## Violations fixed by `align agent run`', ''];
  for (const g of doneGroups) lines.push(`- \`${g.file}\` (${g.commitSha.slice(0, 7)}): ${g.rationale}`);
  return `${lines.join('\n')}\n`;
}

async function performTerminalMerge(
  effects: AgentEffects,
  options: AgentRunOptions,
  groups: readonly GroupOutcome[],
): Promise<TerminalMergeOutcome> {
  const doneGroups = groups.filter((g): g is Extract<GroupOutcome, { status: 'done' }> => g.status === 'done');
  if (doneGroups.length === 0) return { status: 'no-commits' };

  const rebase = await effects.git.rebaseOnto(options.baseBranch);
  if (!rebase.ok) return { status: 'rebase-conflict' };

  const finalCheck = await effects.runCheck();
  if (finalCheck.verdict !== 'green') return { status: 'final-check-red', finalCheck };

  if (options.mode === 'auto-merge') {
    await effects.git.ffMergeAndDeleteBranch(options.workBranchName, options.baseBranch);
    return { status: 'auto-merged' };
  }

  const summary = renderPrSummary(doneGroups);
  const pushResult = await effects.git.push(options.workBranchName);
  if (!pushResult.ok) return { status: 'no-remote-or-no-gh', summary, branch: options.workBranchName };

  const pr = await effects.git.createDraftPr({
    branch: options.workBranchName,
    base: options.baseBranch,
    title: options.prTitle ?? `align: automated fixes (${options.workBranchName})`,
    body: summary,
  });
  if (!pr.ok) return { status: 'no-remote-or-no-gh', summary, branch: options.workBranchName };
  return { status: 'pr-created', url: pr.url, summary };
}

/**
 * Top-level entry point. `ruleset` is passed as data (not an effect) — it's already loaded by the
 * CLI composition root exactly as `align check` loads it, and is needed only to build
 * `ruleExplanations` (pure).
 */
export async function runAgentLoop(effects: AgentEffects, ruleset: RulesetIR, options: AgentRunOptions): Promise<AgentRunResult> {
  if (!(await effects.git.isWorktreeClean())) {
    return { verdict: 'refused', refusalReason: 'dirty worktree — commit or stash changes before running the agent', groups: [] };
  }

  const initialCheck = await effects.runCheck();
  if (initialCheck.verdict === 'error') {
    // Surface WHICH gate errored and WHY — the environmental detail lives on each GateResult's
    // errorMessage; the agent cannot fix it, but the user needs it to act (agent.ts prints next steps).
    const erroring = initialCheck.gates.filter((g) => g.status === 'error');
    const detail = erroring
      .map((g) => `${g.gate} gate: ${g.errorMessage ?? 'unknown error'}`)
      .join('; ');
    return {
      verdict: 'refused',
      refusalReason: `initial \`align check\` could not complete — ${detail || 'a gate errored'}. This is an environment/config problem, not a code violation the agent can fix.`,
      groups: [],
      finalCheck: initialCheck,
    };
  }

  const violations = initialCheck.gates.flatMap((g) => g.violations);
  if (violations.length === 0) {
    return { verdict: 'nothing-to-fix', groups: [], finalCheck: initialCheck };
  }

  const groupsMap = groupViolationsByFile(violations);
  const explanations = ruleExplanationMap(ruleset);

  if (options.dryRun) {
    const groups = await planOnly(effects, groupsMap, explanations);
    return { verdict: 'dry-run', groups };
  }

  await effects.git.createBranch(options.workBranchName);

  const groups: GroupOutcome[] = [];
  for (const [file, groupViolations] of groupsMap) {
    groups.push(await runGroup(effects, file, groupViolations, explanations, options));
  }

  const anyEscalated = groups.some((g) => g.status === 'escalated');
  const terminalMerge = await performTerminalMerge(effects, options, groups);

  return { verdict: anyEscalated ? 'partial-escalated' : 'done', groups, terminalMerge };
}

export function defaultWorkBranchName(now: () => number = Date.now): string {
  const iso = new Date(now()).toISOString().slice(0, 10);
  return `align/fixes-${iso}`;
}
