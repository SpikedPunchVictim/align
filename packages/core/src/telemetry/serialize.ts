import type { TelemetryEnvelope } from './types.js';

/**
 * Pure `event -> single JSON line string` serializer (IMPLEMENTATION_PLAN.md telemetry spec: "Emitter
 * = pure core module (event->line); I/O + file write in CLI"). `JSON.stringify` with no `space`
 * argument never emits an embedded newline, so the result is always exactly one JSONL line — the
 * CLI (`packages/cli/src/telemetry/`) is the only place that appends the trailing `\n` and writes
 * bytes to disk.
 */
export function serializeTelemetryEvent(envelope: TelemetryEnvelope): string {
  return JSON.stringify(envelope);
}
