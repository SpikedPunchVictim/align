import type { ComponentName, RepoRelativePath, RuleId } from '../types/branded.js';
import type { Category } from '../types/violation.js';
import type { ScanBlindSpot } from '../types/graph.js';
import type { UngroundedComponent } from '../components/registry.js';
import type { Advisory, CheckRun, GateStatus } from '../gates/types.js';
import { isRunComplete } from '../gates/advisories.js';
import type { RuleIR } from '../types/ir.js';
import type { Violation } from '../types/violation.js';

// Priority sort before pagination/truncation (ADR 007 rule 3): architecture > security > types >
// lint > format. v1 only ever populates 'architecture', but the ordering contract is fixed now.
const CATEGORY_PRIORITY: Readonly<Record<Category, number>> = {
  architecture: 0,
  security: 1,
  types: 2,
  lint: 3,
  format: 4,
};

export interface BaselineDebt {
  readonly previous: number;
  readonly current: number;
  readonly delta: number;
}

export interface McpCheckPayload {
  readonly verdict: 'green' | 'red' | 'error';
  readonly gates: readonly {
    readonly gate: 'parse' | Category;
    readonly status: GateStatus;
    readonly violationCount: number;
    readonly baselinedCount: number;
    readonly passCount?: number;
  }[];
  readonly violations: readonly Violation[]; // priority-sorted, capped, paginated — failures only
  readonly pagination?: { readonly cursor: string; readonly hasMore: boolean };
  readonly advisories: readonly Advisory[];
  /** R1 (greenfield mode): components that are green only because they matched zero files this
   * scan — structured so an agent can branch on it without string-parsing an advisory message
   * (`{name, selector, policy}` per IMPLEMENTATION_PLAN.md's Design Reserve spec). Verdict stays
   * `green` (an empty greenfield component is not a failure); this field is what makes that green
   * distinguishable from a fully-grounded one. */
  readonly ungroundedComponents: readonly UngroundedComponent[];
  /** ADR 028: every path this scan declined to look at and why, straight off `CheckRun.blindSpots`
   * — wire-visible so an MCP/`--json` consumer can tell "this orphan's file is unobservable, not
   * fixed" without parsing an advisory's message string. `[]` on a run whose architecture gate
   * didn't fully evaluate, same as the source field.
   *
   * Renamed from `skippedNestedCheckouts` in 0.2.0, and that rename was free exactly once:
   * `CheckPayload` carries NO version field (`irVersion: '1'` belongs to the ruleset IR, a different
   * artifact), so a consumer either finds a key or silently does not. Verified before doing it —
   * `git show v0.1.4:packages/core/src/payload/builder.ts` has zero occurrences of the old name, so
   * no published version ever emitted it. Every rename after 0.2.0 is an unsignallable break;
   * versioning this payload owes its own ADR (ADR 028 Consequences). */
  readonly blindSpots: readonly ScanBlindSpot[];
  /** Change in baselined debt since the last persisted baseline: `47 → 45 (−2)`
   * (docs/proposals/reconciled-build-order.md #2). Structured so agents can read the ratchet
   * without parsing prose. */
  readonly baselineDebt: BaselineDebt;
  /** `false` when the graph was built without the repo's external dependencies (a
   * `missing-dependencies` advisory fired) — external-edge rules could not be fully evaluated, so a
   * `green` verdict here is provisional, not authoritative. Structured so a consumer reading
   * `verdict` alone isn't misled by a lying green (same false-green doctrine as `--frozen-rules`,
   * docs/proposals/reconciled-build-order.md #1). `true` for a normal, dependency-complete scan. */
  readonly complete: boolean;
}

export interface BuildCheckPayloadOptions {
  readonly maxPerRule?: number; // first-N-per-rule cap (ADR 007 rule 5); default 10, spike-validated
  readonly cursor?: string; // opaque offset string from a previous page
  readonly pageSize?: number; // max violations in this page across all rules
  readonly baselineDebt?: BaselineDebt;
}

/**
 * Priority sort, cap-per-rule, and page the violations from a `CheckRun` into the structured-only
 * MCP payload shape (ADR 007). Passing gates contribute counts only — never per-item text.
 */
export function buildMcpCheckPayload(run: CheckRun, options: BuildCheckPayloadOptions = {}): McpCheckPayload {
  const maxPerRule = options.maxPerRule ?? 10;
  const pageSize = options.pageSize ?? 50;
  const offset = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10) || 0;

  const allViolations = run.gates.flatMap((g) => g.violations);
  const sorted = sortViolations(allViolations);
  const capped = capPerRule(sorted, maxPerRule);

  const page = capped.slice(offset, offset + pageSize);
  const hasMore = offset + pageSize < capped.length;

  // When the caller didn't supply a baseline delta (e.g. MCP `align_violations`, which has no
  // previous-baseline to diff against), don't fabricate zero DEBT — report the run's real current
  // baselined count with an honest `delta: 0` (this path measures no change, it doesn't claim the
  // debt is zero). On an error run the counts are untrustworthy (gates report 0), so stay at zeros.
  const baselineDebt = options.baselineDebt ?? fallbackBaselineDebt(run);
  const complete = isRunComplete(run);

  return {
    verdict: run.verdict,
    complete,
    gates: run.gates.map((g) => ({
      gate: g.gate,
      status: g.status,
      violationCount: g.violations.length,
      baselinedCount: g.baselinedCount,
      ...(g.passCount === undefined ? {} : { passCount: g.passCount }),
    })),
    violations: page,
    ...(capped.length > pageSize ? { pagination: { cursor: String(offset + pageSize), hasMore } } : {}),
    advisories: run.advisories,
    ungroundedComponents: run.ungroundedComponents,
    blindSpots: run.blindSpots,
    baselineDebt,
  };
}

function fallbackBaselineDebt(run: CheckRun): BaselineDebt {
  if (run.verdict === 'error') return { previous: 0, current: 0, delta: 0 };
  const current = run.gates.reduce((sum, g) => sum + g.baselinedCount, 0);
  return { previous: current, current, delta: 0 };
}

function sortViolations(violations: readonly Violation[]): Violation[] {
  return [...violations].sort((a, b) => {
    const byCategory = CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
    if (byCategory !== 0) return byCategory;
    const byRule = a.ruleId.localeCompare(b.ruleId);
    if (byRule !== 0) return byRule;
    return a.file.localeCompare(b.file);
  });
}

function capPerRule(violations: readonly Violation[], maxPerRule: number): Violation[] {
  const seenPerRule = new Map<RuleId, number>();
  const out: Violation[] = [];
  for (const v of violations) {
    const count = seenPerRule.get(v.ruleId) ?? 0;
    if (count >= maxPerRule) continue;
    seenPerRule.set(v.ruleId, count + 1);
    out.push(v);
  }
  return out;
}

export interface McpExplainRulePayload {
  readonly ruleId: RuleId;
  readonly kind: RuleIR['kind'];
  readonly because?: string;
  readonly components: readonly { readonly name: ComponentName; readonly exampleFiles: readonly RepoRelativePath[] }[];
  readonly mermaid?: string; // fenced cycle/dependency-path diagram (payload/mermaid.ts), present
  // only when the rule currently has a violation instance to diagram — explain-only (ADR 007)
}
