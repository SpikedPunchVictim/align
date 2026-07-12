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

describe('align baseline — move detection (ADR 006, carried-over Stage 1 gap)', () => {
  it('renaming a file with a baselined violation stays green on `align check` and reports the transfer', async () => {
    tmpDir = copyFixture('simple-app-violation');
    expect(await runCheck(tmpDir, { json: false })).toBe(1);
    await baselineAccept(tmpDir, undefined);
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
    const before = readBaseline(tmpDir);
    expect(before).toHaveLength(1);
    const originalFingerprint = before[0]?.fingerprint;

    // Rename the offending file — the import content/snippet is unchanged.
    fs.renameSync(path.join(tmpDir, 'src/api/service.ts'), path.join(tmpDir, 'src/api/renamed.ts'));

    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await runCheck(tmpDir, { json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(code).toBe(0); // stays green across the rename — no orphaned baseline entry
    const payload = JSON.parse(logs.join('')) as { verdict: string; advisories: { kind: string; message: string }[] };
    expect(payload.verdict).toBe('green');
    const advisory = payload.advisories.find((a) => a.kind === 'baseline-moved');
    expect(advisory?.message).toBe('1 entry transferred (file moves).');

    // The transfer is persisted: the baseline entry now points at the renamed file under a new
    // fingerprint, and a second check (fresh load from disk) stays green with no further transfer.
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.file).toBe('src/api/renamed.ts');
    expect(after[0]?.fingerprint).not.toBe(originalFingerprint);
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });

  it('a genuinely new identical-snippet violation in a second file is NOT swallowed as a move', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await baselineAccept(tmpDir, undefined);
    expect(await runCheck(tmpDir, { json: false })).toBe(0);

    // Original violation file is untouched; a second, unrelated api file makes the same forbidden
    // import. Both fingerprints must remain live — the new one surfaces as a fresh red violation.
    fs.writeFileSync(
      path.join(tmpDir, 'src/api/service2.ts'),
      `import { render } from '../ui/component.js';\n\nexport function handleOther(): string {\n  return render();\n}\n`,
      'utf8',
    );

    expect(await runCheck(tmpDir, { json: false })).toBe(1);
    const baseline = readBaseline(tmpDir);
    expect(baseline).toHaveLength(1);
    expect(baseline[0]?.file).toBe('src/api/service.ts'); // original entry untouched
  });

  it('`align baseline prune` also transfers moves, in addition to removing fixed entries', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await baselineAccept(tmpDir, undefined);
    fs.renameSync(path.join(tmpDir, 'src/api/service.ts'), path.join(tmpDir, 'src/api/renamed.ts'));

    await baselinePrune(tmpDir);
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.file).toBe('src/api/renamed.ts');
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });
});
