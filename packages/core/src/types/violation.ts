import type { ComponentName, RepoRelativePath, RuleId, ViolationId } from './branded.js';

// v1 populates 'architecture' only; the union is fixed now so ADR 007/008's priority ordering
// and GateResult shape don't change when later gates add categories.
export type Category = 'architecture' | 'security' | 'types' | 'lint' | 'format';

export type Severity = 'error' | 'warning' | 'info';

export interface SourceRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface CycleEdge {
  readonly from: RepoRelativePath;
  readonly to: RepoRelativePath;
  readonly specifier: string;
  readonly line: number;
}

// Short-code form, not prose — ADR 007: fixHint is structured, message text is rendered at the
// surface layer, never stored on the model itself.
export type FixHint =
  | { readonly code: 'remove-import'; readonly file: RepoRelativePath; readonly line: number }
  | { readonly code: 'relocate-shared-code'; readonly from: ComponentName; readonly to: ComponentName }
  | { readonly code: 'invert-dependency'; readonly owner: ComponentName }
  | { readonly code: 'break-cycle-edge'; readonly suggestedEdge: CycleEdge }
  | { readonly code: 'manual-review' }
  // `arch.metric` (max-LOC), promoted 2026-07-12 on kluster ruleset evidence
  // (IMPLEMENTATION_PLAN.md's Promotion log) — un-reserved from the comment below.
  | { readonly code: 'split-file'; readonly file: RepoRelativePath };
  // Reserved fix-hint codes arrive with their rule kinds (reserve, docs/ir-schema.md):
  // 'rename-to-match-pattern' (arch.naming) · 'reduce-fan-in' / 'reduce-fan-out' (arch.metric,
  // fan-in/fan-out/instability — still reserved pending their own evidence)

interface ViolationBase {
  readonly id: ViolationId; // snippet-hash fingerprint (ADR 006) — stable under unrelated edits
  readonly ruleId: RuleId;
  readonly category: Category;
  readonly severity: Severity;
  readonly file: RepoRelativePath;
  readonly range: SourceRange;
  readonly snippet: string; // exact source text at range — required (ADR 007/010: dedup + future
  // edit-block construction both depend on this)
  readonly fixHint: FixHint;
  readonly because?: string; // hoisted .because() / sourceQuote (ADR 002/011)
}

// Discriminated union, not optional-soup (CODING_BEST_PRACTICES.md §10) — each rule kind's
// structural fields are only present on its own variant.
export type Violation =
  | (ViolationBase & {
      readonly kind: 'no-dependency';
      readonly fromFile: RepoRelativePath;
      readonly toFile: RepoRelativePath;
      readonly fromComponent: ComponentName;
      readonly toComponent: ComponentName;
      readonly specifier: string;
      readonly line: number;
    })
  | (ViolationBase & {
      readonly kind: 'no-cycles';
      readonly chain: readonly CycleEdge[]; // per-edge detail, not just file names (ADR 004)
      readonly suggestedBreakEdge: CycleEdge;
    })
  | (ViolationBase & {
      readonly kind: 'layers';
      readonly fromLayer: ComponentName;
      readonly toLayer: ComponentName;
      readonly fromFile: RepoRelativePath;
      readonly toFile: RepoRelativePath;
      readonly specifier: string;
      readonly line: number;
    })
  | (ViolationBase & {
      readonly kind: 'metric';
      // Literal today (only `loc` is promoted, IMPLEMENTATION_PLAN.md's Promotion log); grows to a
      // union alongside `RuleIR`'s `arch.metric.metric` when fan-in/fan-out/instability graduate.
      readonly metric: 'loc';
      readonly component: ComponentName;
      readonly value: number;
      readonly threshold: number;
    })
  // `custom.host` (registration surface, docs/proposals/rule-expansion-evaluation.md §B.0):
  // `detail` is the registered predicate's own `HostViolation.message` — the only kind whose
  // violation text comes from outside align's own evaluators, so it's kept as a distinct field
  // rather than folded into `because` (which stays reserved for the rule author's `.because()`).
  | (ViolationBase & {
      readonly kind: 'custom';
      readonly hostRuleName: string;
      readonly detail: string;
    });
  // Reserved variant (arrives with its rule kind — reserve pending evidence, docs/ir-schema.md):
  // 'naming' { actual, pattern }

/**
 * Human-facing prose is rendered at the surface, never stored on the model (ADR 007 rule 2:
 * measured 3.6x token reduction, 182 -> 51 tokens/violation, by keeping this out of the machine
 * payload entirely).
 */
export function renderViolationMessage(v: Violation): string {
  switch (v.kind) {
    case 'no-dependency':
      return (
        `${v.fromFile} (component '${v.fromComponent}') imports ${v.toFile} ` +
        `(component '${v.toComponent}') via '${v.specifier}' at line ${v.line}, which rule ` +
        `'${v.ruleId}' forbids.` + (v.because !== undefined ? ` ${v.because}` : '')
      );
    case 'no-cycles': {
      const lastHop = v.chain[v.chain.length - 1];
      const nodeNames: string[] = v.chain.map((e) => String(e.from));
      if (lastHop !== undefined) nodeNames.push(String(lastHop.to));
      const path = nodeNames.join(' -> ');
      return (
        `Import cycle of ${v.chain.length} edge(s) detected: ${path}.` +
        (v.because !== undefined ? ` ${v.because}` : '')
      );
    }
    case 'layers':
      return (
        `${v.fromFile} (layer '${v.fromLayer}') imports ${v.toFile} (layer '${v.toLayer}') via ` +
        `'${v.specifier}' at line ${v.line}, which rule '${v.ruleId}' forbids.` +
        (v.because !== undefined ? ` ${v.because}` : '')
      );
    case 'metric':
      return (
        `${v.file} (component '${v.component}') is ${v.value} lines, exceeding rule '${v.ruleId}'s ` +
        `max-${v.metric} limit of ${v.threshold} lines.` + (v.because !== undefined ? ` ${v.because}` : '')
      );
    case 'custom':
      return (
        `${v.file}: ${v.detail} (rule '${v.ruleId}', host predicate '${v.hostRuleName}').` +
        (v.because !== undefined ? ` ${v.because}` : '')
      );
    default: {
      const exhaustive: never = v;
      throw new Error(`unhandled violation kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
