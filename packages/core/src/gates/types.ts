import type { RuleId } from '../types/branded.js';
import { CATEGORIES, type Violation } from '../types/violation.js';

export type GateStatus = 'green' | 'red' | 'error' | 'skipped';

// Derived from CATEGORIES (types/violation.ts), same single-source-of-truth discipline — 'parse'
// is the one gate kind that isn't a Category (it has no rule kinds of its own; a parse failure
// halts every downstream gate, ADR 008). `align skill`'s generated gate-list section reads this
// array directly (packages/cli/src/skill/gates.ts) so it cannot silently drift from GateResult's
// own shape.
export const GATE_KINDS = ['parse', ...CATEGORIES] as const;
export type GateKind = (typeof GATE_KINDS)[number];

export interface GateResult {
  readonly gate: GateKind;
  readonly status: GateStatus;
  readonly violations: readonly Violation[]; // only if 'red' — new, post-baseline
  readonly baselinedCount: number; // tolerated debt — count only, never payloads (ADR 007)
  readonly passCount?: number;
  readonly errorMessage?: string; // only if 'error' — environmental, never LLM-facing
  readonly durationMs: number;
  readonly cacheHits: number; // always 0 in v1 (ADR 005); field exists for the growth path
  readonly dependsOn: readonly (GateResult['gate'])[]; // declared metadata, not hardcoded order (ADR 008)
}

export interface Advisory {
  readonly kind: string; // e.g. 'config-conflict' | 'doc-drift' | 'divergence' | 'flaky'
  readonly message: string;
  readonly ruleIds?: readonly RuleId[];
}

export interface CheckRun {
  readonly verdict: 'green' | 'red' | 'error';
  readonly gates: readonly GateResult[];
  readonly advisories: readonly Advisory[]; // included even when verdict is green
  readonly scannedAt: number;
}
