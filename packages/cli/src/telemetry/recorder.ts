import { serializeTelemetryEvent, TELEMETRY_SCHEMA_VERSION, type TelemetryEvent } from '@spikedpunch/align-core';
import { appendTelemetryLine } from '../align-dir.js';
import { resolveTelemetryEnabled } from './resolve.js';
import { ALIGN_VERSION, TELEMETRY_SESSION_ID } from './process-context.js';

export interface TelemetryRecorderOptions {
  readonly rootDir: string;
  readonly enabled: boolean;
  readonly sessionId: string;
  readonly alignVersion: string;
  readonly command: string;
  /** Injected, never `Date.now()` called ad hoc — every envelope from one recorder shares the
   * same clock function (real deployments: `Date.now`; tests: a fixed/stepped fake). */
  readonly now: () => number;
  /** Test/override hook — mirrors `align check --ir <path>`'s override pattern. Defaults to
   * `.align/telemetry.jsonl` (`align-dir.ts`). */
  readonly jsonlPathOverride?: string;
}

/**
 * The ONE wrapper that builds the envelope and writes it (IMPLEMENTATION_PLAN.md's telemetry spec:
 * "prefer ONE wrapper... over scattering emit calls"). Every command that emits telemetry
 * constructs exactly one of these (via `program.ts`'s `buildTelemetryRecorder`) and calls
 * `.record()` with its own domain event — no command touches `appendTelemetryLine` or builds an
 * envelope itself.
 */
export class TelemetryRecorder {
  constructor(private readonly options: TelemetryRecorderOptions) {}

  get enabled(): boolean {
    return this.options.enabled;
  }

  record(event: TelemetryEvent, opts: { readonly rulesetIrHash?: string } = {}): void {
    if (!this.options.enabled) return;
    const envelope = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      sessionId: this.options.sessionId,
      alignVersion: this.options.alignVersion,
      ...(opts.rulesetIrHash !== undefined ? { rulesetIrHash: opts.rulesetIrHash } : {}),
      ts: this.options.now(),
      command: this.options.command,
      event,
    };
    appendTelemetryLine(this.options.rootDir, serializeTelemetryEvent(envelope), this.options.jsonlPathOverride);
  }
}

/** OFF-by-default (IMPLEMENTATION_PLAN.md): a recorder constructed with `enabled: false` never
 * calls `appendTelemetryLine` — `.record()` is a no-op, so `.align/telemetry.jsonl` is never even
 * created, let alone written to. */
export function createDisabledTelemetryRecorder(rootDir: string, command: string): TelemetryRecorder {
  return new TelemetryRecorder({ rootDir, enabled: false, sessionId: '', alignVersion: '', command, now: Date.now });
}

/**
 * The composition-root factory every command calls (`program.ts` is the "central wiring point" —
 * it resolves the pre-config half of the precedence via CLI flags/`ALIGN_TELEMETRY`, then each
 * command finishes the resolution once it has loaded `align.config.ts`'s own `telemetry` export
 * and calls this). `sessionId`/`alignVersion` always come from the shared process-wide constants
 * (`process-context.ts`) — never re-derived per call — so every event in one `align` invocation,
 * across however many commands ran, shares the same session id.
 */
export function createTelemetryRecorder(
  rootDir: string,
  command: string,
  preConfig: boolean | undefined,
  configTelemetry: boolean | undefined,
  jsonlPathOverride?: string,
): TelemetryRecorder {
  const enabled = resolveTelemetryEnabled(preConfig, configTelemetry);
  return new TelemetryRecorder({
    rootDir,
    enabled,
    sessionId: TELEMETRY_SESSION_ID,
    alignVersion: ALIGN_VERSION,
    command,
    now: Date.now,
    ...(jsonlPathOverride !== undefined ? { jsonlPathOverride } : {}),
  });
}
