/**
 * Telemetry / 360-feedback loop (IMPLEMENTATION_PLAN.md Design Reserve "Telemetry / 360-feedback
 * loop", ADR 015). Event type definitions only — this file has zero `node:fs` / `Date.now()` /
 * network primitives, matching every other file under `packages/core/src` (ARCHITECTURE.md §5:
 * core stays framework-free, the CLI is the imperative shell that does I/O).
 *
 * LOCAL-FILE-ONLY, NEVER NETWORK (align's own untrusted-mode/security ethos, ADR 001/014): these
 * types describe the shape of one JSON line appended to `.align/telemetry.jsonl` by the CLI. This
 * module never imports anything that could reach a socket — enforced by
 * `test/telemetry/network-abstinence.test.ts`, which asserts no network primitive is imported
 * anywhere under `packages/core/src/telemetry` or `packages/cli/src/telemetry`.
 */
import type { GateKind, GateStatus } from '../gates/types.js';

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export type TelemetrySchemaVersion = typeof TELEMETRY_SCHEMA_VERSION;

/** `align check` only ever does a full fresh scan today (ADR 005: rescan-on-check, no caching) —
 * 'changed'/'files' are reserved discriminants for a future scoped-check mode (same "reserve
 * pending evidence" doctrine as `GATE_KINDS`'s `types`/`lint`/`format` and `FixHint`'s reserved
 * codes), not fabricated data. The CLI always emits 'all' in v1. */
export type CheckScope = 'all' | 'changed' | 'files';

export interface GateSummary {
  readonly gate: GateKind;
  readonly status: GateStatus;
  /** Count of new, post-baseline violations this gate reported this run (`GateResult.violations.length`). */
  readonly newCount: number;
  readonly baselinedCount: number;
  readonly passCount: number;
}

export interface AdvisoryCount {
  readonly kind: string;
  readonly count: number;
}

export interface CheckEvent {
  readonly kind: 'check';
  readonly verdict: 'green' | 'red' | 'error';
  readonly gates: readonly GateSummary[];
  readonly wallMs: number;
  readonly scope: CheckScope;
  readonly ungroundedComponentCount: number;
  readonly advisoryCounts: readonly AdvisoryCount[];
}

/**
 * Emitted by diffing the current check's violation-fingerprint set against the previous check's
 * set (`.align/telemetry-state.json`, `diffViolationState` below) — never computed from a single
 * check in isolation. `violationFingerprint` is the same stable `Violation.id` ADR 006 already
 * defines (snippet-hash, stable under unrelated edits), so `appeared -> resolved` pairs sharing a
 * fingerprint are exactly the time-to-green signal the summarizer command correlates.
 */
export interface ViolationTransitionEvent {
  readonly kind: 'violation-appeared' | 'violation-resolved';
  readonly ruleId: string;
  readonly component?: string;
  readonly file: string;
  readonly violationFingerprint: string;
}

export interface BaselineEvent {
  readonly kind: 'baseline';
  readonly action: 'accept' | 'prune';
  /** The `--rule <ruleId>` scope, when the action was scoped; absent for a repo-wide accept/prune. */
  readonly ruleScope?: string;
  readonly counts: {
    readonly accepted?: number;
    readonly removed?: number;
    readonly moved?: number;
  };
}

export interface BuildImpactDelta {
  readonly newViolations: number;
  readonly maskedBaselined: number;
}

export interface BuildEvent {
  readonly kind: 'build';
  readonly doc: string;
  readonly structuralChanges: number;
  readonly provenanceOnlyChanges: number;
  readonly impactDelta: BuildImpactDelta;
}

/** `unknown-host-rule` / `ungrounded-fail` are reserved discriminants (same reserve-pending-
 * evidence doctrine as `CheckScope` above): today's guard-step failures (unregistered
 * `custom.host` predicate, a component matching zero files) surface as an architecture-gate
 * `error` and are reported as `'gate-error'`; a future pass may want to distinguish them by cause
 * without inventing a value no code path emits yet. */
export type TelemetryErrorKind =
  | 'gate-error'
  | 'exception'
  | 'untrusted-refusal'
  | 'unknown-host-rule'
  | 'ungrounded-fail'
  | 'unknown';

export interface ErrorEvent {
  readonly kind: 'error';
  readonly errorKind: TelemetryErrorKind;
  /** SHORT message only — no secrets, no file contents (IMPLEMENTATION_PLAN.md's telemetry spec,
   * ADR 007's payload-discipline doctrine applied to this surface too). */
  readonly message: string;
  readonly command: string;
}

export interface AgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AgentEvent {
  readonly kind: 'agent';
  readonly attempts: number;
  readonly converged: boolean;
  readonly iterations: number;
  readonly escalated: boolean;
  readonly escalationReason?: string;
  /** Only present when `@anthropic-ai/sdk`'s response actually surfaced `usage` — never
   * fabricated (IMPLEMENTATION_PLAN.md: "if absent, omit the field, don't fabricate", closing the
   * Kimi-flagged observability gap). */
  readonly usage?: AgentUsage;
}

export type TelemetryEvent = CheckEvent | ViolationTransitionEvent | BaselineEvent | BuildEvent | ErrorEvent | AgentEvent;

/**
 * The envelope every event carries (the cross-session-comparability refinement,
 * IMPLEMENTATION_PLAN.md's telemetry spec) — `ts` and `sessionId` are injected, never computed in
 * core (no `Date.now()`/`crypto.randomUUID()` here; the CLI, the imperative shell, supplies both).
 */
export interface TelemetryEnvelope<E extends TelemetryEvent = TelemetryEvent> {
  readonly schemaVersion: TelemetrySchemaVersion;
  readonly sessionId: string;
  readonly alignVersion: string;
  /** Content hash of the loaded `RulesetIR` (reuses `sha256Hex`, `build/hash.ts`) — absent when no
   * ruleset was ever loaded for this event (e.g. an `--untrusted` refusal before the IR artifact
   * was even read). */
  readonly rulesetIrHash?: string;
  readonly ts: number;
  readonly command: string;
  readonly event: E;
}

/** One entry in `.align/telemetry-state.json` — the minimal fields `diffViolationState` needs to
 * name a transition without re-reading the file the violation lives in. */
export interface TelemetryStateEntry {
  readonly fingerprint: string;
  readonly ruleId: string;
  readonly file: string;
  readonly component?: string;
}

export interface TelemetryState {
  readonly violations: readonly TelemetryStateEntry[];
}

export const EMPTY_TELEMETRY_STATE: TelemetryState = { violations: [] };
