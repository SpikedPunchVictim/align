import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTelemetryState, writeTelemetryState } from '../../src/align-dir.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('.align/telemetry-state.json', () => {
  it('a missing file reads as empty state', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-telemetry-state-'));
    expect(readTelemetryState(tmpDir)).toEqual({ violations: [] });
  });

  it('round-trips a written state', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-telemetry-state-'));
    const state = { violations: [{ fingerprint: 'v1', ruleId: 'r1', file: 'a.ts', component: 'api' }] };
    writeTelemetryState(tmpDir, state);
    expect(readTelemetryState(tmpDir)).toEqual(state);
  });

  it('invalid JSON is treated as empty state, not thrown', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-telemetry-state-'));
    fs.mkdirSync(path.join(tmpDir, '.align'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.align', 'telemetry-state.json'), '{ not valid json', 'utf8');
    expect(() => readTelemetryState(tmpDir)).not.toThrow();
    expect(readTelemetryState(tmpDir)).toEqual({ violations: [] });
  });

  it('valid JSON with the wrong shape is treated as empty state', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-telemetry-state-'));
    fs.mkdirSync(path.join(tmpDir, '.align'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.align', 'telemetry-state.json'), JSON.stringify({ nope: 'wrong shape' }), 'utf8');
    expect(readTelemetryState(tmpDir)).toEqual({ violations: [] });
  });

  it('a bare JSON array (not the expected object shape) is treated as empty state', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-telemetry-state-'));
    fs.mkdirSync(path.join(tmpDir, '.align'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.align', 'telemetry-state.json'), '[1,2,3]', 'utf8');
    expect(readTelemetryState(tmpDir)).toEqual({ violations: [] });
  });
});
