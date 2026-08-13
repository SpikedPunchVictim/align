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
  isRunComplete,
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
  /** ADR 023 tier 2, mirrored from `init`/`prune`/`upgrade`'s `--allow-incomplete`: by default, a
   * green-but-incomplete (`missing-dependencies` advisory) VERIFY or terminal-merge check must NOT
   * be trusted as evidence a fix worked — an absent violation on such a run may be unobservable
   * rather than fixed (ADR 023's "second axis"). Passing this restores the old behaviour of trusting
   * any green run regardless of completeness. See `isRunComplete` (`@spikedpunch/align-core`,
   * `gates/advisories.ts`) — the one shared predicate this option gates, never re-derived here. */
  readonly allowIncomplete: boolean;
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
  | { readonly status: 'final-check-incomplete'; readonly finalCheck: CheckRun }
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

const ZERO_COVERAGE_REASON =
  'zero test coverage — no scanned test file transitively imports this file (pass --allow-untested to override)';

/** Green≠correct guard (c), ADR 023 tier 2: a VERIFY (or terminal-merge) run whose gates are all
 * green but which could not resolve the whole dependency graph (`missing-dependencies` advisory,
 * `isRunComplete`) must not be trusted as proof a fix worked — a violation routed through a dropped
 * edge is unobservable, not fixed. Overridable with `--allow-incomplete`, worded and named to match
 * the same flag on `init`/`prune`/`upgrade`. */
const INCOMPLETE_VERIFY_REASON =
  'VERIFY produced a green run that could not resolve all dependencies (missing-dependencies advisory) — an ' +
  'absent violation may be unobservable rather than fixed, so this cannot be trusted as evidence the fix ' +
  'worked (pass --allow-incomplete to override)';

/** Green≠correct guard (b): zero-coverage refusal, shared by the real per-group loop (`runGroup`)
 * and the `--dry-run` planning loop (`planOnly`). A file that would be escalated for zero
 * coverage in a real run must never reach `fixProvider.proposeFix` in a dry run either — sending
 * its contents to the model is exactly what `--allow-untested`'s "(default: refuse)" promises not
 * to do. Returns the 'escalated' outcome when the guard fires, `undefined` when the file may
 * proceed to PLAN+FIX. Only scans the graph when the gate is actually active (`!allowUntested`),
 * matching the original `runGroup`-only behavior — `--allow-untested` skips the scan entirely. */
async function coverageGateOutcome(
  effects: AgentEffects,
  file: RepoRelativePath,
  options: Pick<AgentRunOptions, 'allowUntested'>,
): Promise<GroupOutcome | undefined> {
  if (options.allowUntested) return undefined;
  const graph = await effects.scanGraph();
  if (isFileCovered(file, graph)) return undefined;
  return { status: 'escalated', file, reason: ZERO_COVERAGE_REASON };
}

/** DISCOVER + GROUP + PLAN only — used for `--dry-run`. Applies the same zero-coverage guard as
 * `runGroup` (via `coverageGateOutcome`) before ever calling the FixProvider, then otherwise stops
 * short of the full per-group APPLY/VERIFY/REPAIR loop below. */
async function planOnly(
  effects: AgentEffects,
  groupsMap: ReadonlyMap<RepoRelativePath, readonly Violation[]>,
  explanations: ReadonlyMap<RuleId, RuleExplanation>,
  options: AgentRunOptions,
): Promise<readonly GroupOutcome[]> {
  const outcomes: GroupOutcome[] = [];
  for (const [file, violations] of groupsMap) {
    const coverageEscalation = await coverageGateOutcome(effects, file, options);
    if (coverageEscalation !== undefined) {
      outcomes.push(coverageEscalation);
      continue;
    }
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
  // Shared with the `--dry-run` path (`planOnly`) via `coverageGateOutcome` so a second code path
  // can never forget the guard the way `--dry-run` originally did.
  const coverageEscalation = await coverageGateOutcome(effects, file, options);
  if (coverageEscalation !== undefined) return coverageEscalation;

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
      // Green≠correct guard (c): a green VERIFY that could not resolve the whole dependency graph
      // is not evidence this group's violation is actually gone (ADR 023 tier 2) — escalate rather
      // than report DONE. The commit stays in place (consistent with the gate-error escalation
      // above): this cannot be proven wrong, only unproven, so reverting a plausibly-correct fix
      // would be no more justified than keeping it.
      if (!isRunComplete(checkRun) && !options.allowIncomplete) {
        return { status: 'escalated', file, reason: INCOMPLETE_VERIFY_REASON };
      }
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

  // Green≠correct guard (c), ADR 023 tier 2: the rebased-tip check is the last line of defense
  // before merging/opening a PR — a green verdict that could not resolve the whole dependency graph
  // is not proof the rebase left the repo actually clean. Gates BOTH terminal-merge paths (not just
  // --auto-merge): the decided design is "the terminal merge must not proceed on an incomplete run",
  // and a PR built from an unverified green is still asserting the fixes are good.
  if (!isRunComplete(finalCheck) && !options.allowIncomplete) {
    return { status: 'final-check-incomplete', finalCheck };
  }

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
    const groups = await planOnly(effects, groupsMap, explanations, options);
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
