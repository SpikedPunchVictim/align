import type { RuleId } from '../types/branded.js';
import type { Category, Violation } from '../types/violation.js';

export type GateStatus = 'green' | 'red' | 'error' | 'skipped';

export interface GateResult {
  readonly gate: 'parse' | Category;
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
