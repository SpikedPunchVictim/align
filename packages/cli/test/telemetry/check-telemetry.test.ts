import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/commands/check.js';
import { telemetryJsonlPath } from '../../src/align-dir.js';
import { buildTelemetrySummary } from '../../src/commands/telemetry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'fixtures');

let tmpDir: string;
let savedEnv: string | undefined;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cli-telemetry-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

beforeEach(() => {
  savedEnv = process.env['ALIGN_TELEMETRY'];
  delete process.env['ALIGN_TELEMETRY'];
});

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env['ALIGN_TELEMETRY'];
  else process.env['ALIGN_TELEMETRY'] = savedEnv;
});

describe('align check — telemetry OFF by default', () => {
  it('writes nothing when telemetry is not enabled by any of flag/env/config', async () => {
    tmpDir = copyFixture('simple-app');
    await runCheck(tmpDir, { json: false });
    expect(fs.existsSync(telemetryJsonlPath(tmpDir))).toBe(false);
  });
});

describe('align check — telemetry --no-telemetry overrides ALIGN_TELEMETRY=1', () => {
  it('writes nothing even with the env var set, when telemetryPreConfig resolves to false', async () => {
    tmpDir = copyFixture('simple-app');
    process.env['ALIGN_TELEMETRY'] = '1';
    await runCheck(tmpDir, { json: false, telemetryPreConfig: false });
    expect(fs.existsSync(telemetryJsonlPath(tmpDir))).toBe(false);
  });
});

describe('align check — telemetry enabled: check/appear/resolve sequence + time-to-green', () => {
  it('accretes a check event per run and appear/resolve events for a fixed violation, computing a real time-to-green', async () => {
    tmpDir = copyFixture('simple-app-violation');

    // check #1: red — a violation-appeared event should be recorded alongside the check event.
    const code1 = await runCheck(tmpDir, { json: false, telemetryPreConfig: true });
    expect(code1).toBe(1);

    const jsonlPath = telemetryJsonlPath(tmpDir);
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const linesAfterFirst = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const kindsAfterFirst = linesAfterFirst.map((l) => (JSON.parse(l) as { event: { kind: string } }).event.kind);
    expect(kindsAfterFirst).toContain('check');
    expect(kindsAfterFirst).toContain('violation-appeared');
    expect(kindsAfterFirst).not.toContain('violation-resolved');

    // Fix: remove the forbidden import + its usage.
    const servicePath = path.join(tmpDir, 'src', 'api', 'service.ts');
    fs.writeFileSync(servicePath, "export function handleRequest(): string {\n  return 'ok';\n}\n", 'utf8');

    // check #2: green — the same fingerprint should now show up as violation-resolved.
    const code2 = await runCheck(tmpDir, { json: false, telemetryPreConfig: true });
    expect(code2).toBe(0);

    // check #3: still green — no new transitions (diffing is stable/idempotent).
    const code3 = await runCheck(tmpDir, { json: false, telemetryPreConfig: true });
    expect(code3).toBe(0);

    const allLines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const allEvents = allLines.map((l) => (JSON.parse(l) as { event: { kind: string } }).event);
    expect(allEvents.filter((e) => e.kind === 'check')).toHaveLength(3);
    expect(allEvents.filter((e) => e.kind === 'violation-appeared')).toHaveLength(1);
    expect(allEvents.filter((e) => e.kind === 'violation-resolved')).toHaveLength(1);

    const summary = await buildTelemetrySummary(tmpDir, jsonlPath);
    expect(summary.checkLatencyMs.count).toBe(3);
    expect(summary.topFiringRules).toHaveLength(1);
    expect(summary.topFiringRules[0]?.count).toBe(1);
    expect(summary.timeToGreen).toHaveLength(1);
    expect(summary.timeToGreen[0]?.resolvedCount).toBe(1);
    expect(summary.timeToGreen[0]?.avgMs).toBeGreaterThanOrEqual(0);
    expect(summary.baselineVsFix.resolved).toBe(1);
    expect(summary.baselineVsFix.baselined).toBe(0);
    // The fixture's one rule fired — so it must not show up as a dead rule.
    expect(summary.deadRules).toEqual([]);
  });
});
