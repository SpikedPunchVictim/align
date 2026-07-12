import type { ComponentName, RepoRelativePath, RuleId } from '../types/branded.js';
import type { Category } from '../types/violation.js';
import type { Advisory, CheckRun, GateStatus } from '../gates/types.js';
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
}

export interface BuildCheckPayloadOptions {
  readonly maxPerRule?: number; // first-N-per-rule cap (ADR 007 rule 5); default 10, spike-validated
  readonly cursor?: string; // opaque offset string from a previous page
  readonly pageSize?: number; // max violations in this page across all rules
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

  return {
    verdict: run.verdict,
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
  };
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
  readonly mermaid?: string; // cycle/dependency-path diagram, arch kinds only — deferred to Stage 2
}
