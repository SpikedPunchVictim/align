import { describe, expect, it } from 'vitest';
import { serializeTelemetryEvent } from '../../src/telemetry/serialize.js';
import { TELEMETRY_SCHEMA_VERSION, type CheckEvent, type TelemetryEnvelope } from '../../src/telemetry/types.js';

function envelope(event: CheckEvent): TelemetryEnvelope<CheckEvent> {
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    sessionId: 'session-1',
    alignVersion: '0.1.0',
    rulesetIrHash: 'abc123',
    ts: 1_700_000_000_000,
    command: 'check',
    event,
  };
}

describe('serializeTelemetryEvent', () => {
  it('produces exactly one JSON line (no embedded newlines)', () => {
    const line = serializeTelemetryEvent(
      envelope({
        kind: 'check',
        verdict: 'green',
        gates: [{ gate: 'architecture', status: 'green', newCount: 0, baselinedCount: 0, passCount: 3 }],
        wallMs: 42,
        scope: 'all',
        ungroundedComponentCount: 0,
        advisoryCounts: [],
      }),
    );
    expect(line.includes('\n')).toBe(false);
    expect(line.split('\n')).toHaveLength(1);
  });

  it('round-trips through JSON.parse to an equivalent envelope', () => {
    const original = envelope({
      kind: 'check',
      verdict: 'red',
      gates: [{ gate: 'architecture', status: 'red', newCount: 2, baselinedCount: 1, passCount: 1 }],
      wallMs: 123,
      scope: 'all',
      ungroundedComponentCount: 1,
      advisoryCounts: [{ kind: 'unmapped-files', count: 3 }],
    });
    const line = serializeTelemetryEvent(original);
    const parsed = JSON.parse(line) as TelemetryEnvelope<CheckEvent>;
    expect(parsed).toEqual(original);
  });

  it('every envelope field is present in the serialized line', () => {
    const line = serializeTelemetryEvent(
      envelope({
        kind: 'check',
        verdict: 'green',
        gates: [],
        wallMs: 1,
        scope: 'all',
        ungroundedComponentCount: 0,
        advisoryCounts: [],
      }),
    );
    const parsed = JSON.parse(line) as Record<string, unknown>;
    for (const key of ['schemaVersion', 'sessionId', 'alignVersion', 'rulesetIrHash', 'ts', 'command', 'event']) {
      expect(parsed).toHaveProperty(key);
    }
  });
});
