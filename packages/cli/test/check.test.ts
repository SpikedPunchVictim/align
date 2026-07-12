import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { baselineAccept, baselinePrune, baselineShow } from '../src/commands/baseline.js';
import { readBaseline } from '../src/align-dir.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cli-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('align check', () => {
  it('exits 0 on a clean fixture', async () => {
    tmpDir = copyFixture('simple-app');
    const code = await runCheck(tmpDir, { json: false });
    expect(code).toBe(0);
  });

  it('exits 1 on a fixture with a seeded violation', async () => {
    tmpDir = copyFixture('simple-app-violation');
    const code = await runCheck(tmpDir, { json: false });
    expect(code).toBe(1);
  });

  it('--json produces the structured McpCheckPayload shape', async () => {
    tmpDir = copyFixture('simple-app-violation');
    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCheck(tmpDir, { json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    const payload = JSON.parse(logs.join('')) as { verdict: string; gates: unknown[]; violations: unknown[] };
    expect(payload.verdict).toBe('red');
    expect(Array.isArray(payload.gates)).toBe(true);
    expect(Array.isArray(payload.violations)).toBe(true);
    expect(payload.violations).toHaveLength(1);
  });

  it('freshness: fixing the violation on disk turns the next check green with no restart', async () => {
    tmpDir = copyFixture('simple-app-violation');
    expect(await runCheck(tmpDir, { json: false })).toBe(1);

    // The "fix": remove the forbidden import.
    fs.writeFileSync(
      path.join(tmpDir, 'src/api/service.ts'),
      `export function handleRequest(): string {\n  return 'ok';\n}\n`,
      'utf8',
    );
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });
});

describe('align baseline', () => {
  it('accept seeds the baseline and turns check green; prune removes it once fixed', async () => {
    tmpDir = copyFixture('simple-app-violation');
    expect(await runCheck(tmpDir, { json: false })).toBe(1);

    await baselineAccept(tmpDir, undefined);
    expect(readBaseline(tmpDir)).toHaveLength(1);
    expect(await runCheck(tmpDir, { json: false })).toBe(0);

    fs.writeFileSync(
      path.join(tmpDir, 'src/api/service.ts'),
      `export function handleRequest(): string {\n  return 'ok';\n}\n`,
      'utf8',
    );
    await baselinePrune(tmpDir);
    expect(readBaseline(tmpDir)).toHaveLength(0);
  });

  it('accept --rule only accepts violations of the named rule', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await baselineAccept(tmpDir, 'nonexistent-rule');
    expect(readBaseline(tmpDir)).toHaveLength(0);
    expect(await runCheck(tmpDir, { json: false })).toBe(1);
  });

  it('show lists baselined entries', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await baselineAccept(tmpDir, undefined);
    const code = await baselineShow(tmpDir, undefined);
    expect(code).toBe(0);
  });
});
