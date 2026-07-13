import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTelemetrySummary } from '../../src/commands/telemetry.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function envelope(command: string, sessionId: string, alignVersion: string, ts: number, event: unknown): string {
  return JSON.stringify({ schemaVersion: 1, sessionId, alignVersion, ts, command, event });
}

function writeJsonl(lines: readonly string[]): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-telemetry-summary-'));
  const file = path.join(tmpDir, 'telemetry.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

describe('buildTelemetrySummary', () => {
  it('skips malformed lines without throwing, and counts them', async () => {
    const file = writeJsonl(['not json at all', '{"missing":"fields"}', envelope('check', 's1', '0.1.0', 1000, { kind: 'check', verdict: 'green', gates: [], wallMs: 10, scope: 'all', ungroundedComponentCount: 0, advisoryCounts: [] })]);
    const summary = await buildTelemetrySummary(path.dirname(file), file);
    expect(summary.skippedLines).toBe(2);
    expect(summary.totalEvents).toBe(1);
  });

  it('computes check latency percentiles', async () => {
    const lines = [10, 20, 30, 40, 50].map((wallMs, i) =>
      envelope('check', 's1', '0.1.0', 1000 + i, { kind: 'check', verdict: 'green', gates: [], wallMs, scope: 'all', ungroundedComponentCount: 0, advisoryCounts: [] }),
    );
    const file = writeJsonl(lines);
    const summary = await buildTelemetrySummary(path.dirname(file), file);
    expect(summary.checkLatencyMs.count).toBe(5);
    expect(summary.checkLatencyMs.p50).toBe(30);
  });

  it('ranks friction by error kind frequency', async () => {
    const lines = [
      envelope('check', 's1', '0.1.0', 1000, { kind: 'error', errorKind: 'gate-error', message: 'boom', command: 'check' }),
      envelope('check', 's1', '0.1.0', 1001, { kind: 'error', errorKind: 'gate-error', message: 'boom2', command: 'check' }),
      envelope('check --untrusted', 's1', '0.1.0', 1002, { kind: 'error', errorKind: 'untrusted-refusal', message: 'no ir', command: 'check --untrusted' }),
    ];
    const file = writeJsonl(lines);
    const summary = await buildTelemetrySummary(path.dirname(file), file);
    expect(summary.friction).toEqual([
      { errorKind: 'gate-error', count: 2 },
      { errorKind: 'untrusted-refusal', count: 1 },
    ]);
  });

  it('reports baseline-vs-fix from baseline-accept and violation-resolved events', async () => {
    const lines = [
      envelope('baseline accept', 's1', '0.1.0', 1000, { kind: 'baseline', action: 'accept', counts: { accepted: 3 } }),
      envelope('check', 's1', '0.1.0', 1001, { kind: 'violation-resolved', ruleId: 'r1', file: 'a.ts', violationFingerprint: 'v1' }),
    ];
    const file = writeJsonl(lines);
    const summary = await buildTelemetrySummary(path.dirname(file), file);
    expect(summary.baselineVsFix).toEqual({ baselined: 3, resolved: 1, ratio: 0.75 });
  });

  it('segments check latency by session id', async () => {
    const lines = [
      envelope('check', 'session-a', '0.1.0', 1000, { kind: 'check', verdict: 'green', gates: [], wallMs: 10, scope: 'all', ungroundedComponentCount: 0, advisoryCounts: [] }),
      envelope('check', 'session-a', '0.1.0', 1001, { kind: 'check', verdict: 'green', gates: [], wallMs: 20, scope: 'all', ungroundedComponentCount: 0, advisoryCounts: [] }),
      envelope('check', 'session-b', '0.1.0', 1002, { kind: 'check', verdict: 'green', gates: [], wallMs: 5, scope: 'all', ungroundedComponentCount: 0, advisoryCounts: [] }),
    ];
    const file = writeJsonl(lines);
    const summary = await buildTelemetrySummary(path.dirname(file), file);
    const bySession = new Map(summary.segments.bySession.map((s) => [s.key, s.checks]));
    expect(bySession.get('session-a')).toBe(2);
    expect(bySession.get('session-b')).toBe(1);
  });

  it('an empty/missing file summarizes as all-zero, not an error', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-telemetry-summary-'));
    const file = path.join(tmpDir, 'does-not-exist.jsonl');
    const summary = await buildTelemetrySummary(tmpDir, file);
    expect(summary.totalEvents).toBe(0);
    expect(summary.checkLatencyMs.count).toBe(0);
    expect(summary.topFiringRules).toEqual([]);
  });
});
