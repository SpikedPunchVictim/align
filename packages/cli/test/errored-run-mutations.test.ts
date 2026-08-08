import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readBaseline, writeBaseline } from '../src/align-dir.js';
import { baselineAccept, baselinePrune } from '../src/commands/baseline.js';
import { runCheck } from '../src/commands/check.js';
import { runInit } from '../src/commands/init.js';
import { toRuleId, toRepoRelativePath, toViolationId } from '@spikedpunch/align-core';

// Bug hunt 2026-08-08, BUG #18: an errored gate reports `violations: []` WITHOUT having evaluated
// anything (orchestrator.ts returns an `errorGate` before rule evaluation), so on `verdict: 'error'`
// every accepted baseline entry looks orphaned. `baseline prune` deleted them all — printing
// "Pruned N fixed violation(s)" and exiting 0 — and `init`'s zero-violation branch wrote `[]` over
// an existing baseline while printing "Initial check is green". Absent ≠ fixed on an incomplete
// scan. Reproduction below is the real one: a component whose selector is fully shadowed by an
// earlier component under first-match-wins, which `validateClassifiedComponents` errors on.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-errored-run-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baselinePath(rootDir: string): string {
  return path.join(rootDir, '.align', 'baseline.json');
}

/**
 * `simple-app-violation` with `api` shadowed by an earlier, broader component — first-match-wins
 * classification leaves `api` with zero files, which `validateClassifiedComponents` reports as an
 * ERRORED architecture gate. The shadowing config is written before the first config load (a
 * dynamic `import()` of the same absolute path is module-cached in-process, so a config rewritten
 * mid-test would silently keep serving the old ruleset), and the baseline is seeded directly —
 * exactly the real-world shape: debt accepted at some earlier commit, config broken later.
 */
function copyErroredFixture(): string {
  const dest = copyFixture('simple-app-violation');
  fs.writeFileSync(
    path.join(dest, 'align.config.ts'),
    `import { defineProject } from '@spikedpunch/align-core/dsl';\n\n` +
      `export default defineProject({\n` +
      `  components: { outer: 'src/**', api: 'src/api/**', ui: 'src/ui/**' },\n` +
      `  rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui).because('The API must remain headless.')],\n` +
      `});\n`,
    'utf8',
  );
  // The real fingerprint `align baseline accept` produces for this fixture's seeded violation, and
  // a file that IS still present in the scan — the exact combination `store.prune` deletes.
  writeBaseline(dest, [
    {
      fingerprint: toViolationId('b26ffb86865fc059'),
      ruleId: toRuleId('arch.no-dependency:api->ui'),
      file: toRepoRelativePath('src/api/service.ts'),
      acceptedAt: 1_700_000_000_000,
      acceptedBy: 'manual',
    },
  ]);
  return dest;
}

async function withCapturedConsole<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = ((...args: unknown[]) => logs.push(args.map(String).join(' '))) as typeof console.log;
  console.error = ((...args: unknown[]) => errors.push(args.map(String).join(' '))) as typeof console.error;
  try {
    return { result: await run(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('`align baseline prune` on an error-verdict run (the data-loss regression)', () => {
  it('refuses, exits non-zero, and leaves .align/baseline.json byte-for-byte unchanged', async () => {
    tmpDir = copyErroredFixture();
    expect(readBaseline(tmpDir)).toHaveLength(1);
    // The precondition the whole bug rests on: this run's verdict really is `error`.
    const { result: checkCode, logs: checkLogs } = await withCapturedConsole(() => runCheck(tmpDir, { json: false }));
    expect(checkCode).toBe(1);
    expect(checkLogs.join('\n')).toMatch(/verdict: error/);

    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');
    const { result: code, logs } = await withCapturedConsole(() => baselinePrune(tmpDir));

    expect(code).not.toBe(0);
    // Byte-identical, not merely "still one entry" — the entries carry irreplaceable acceptedAt/by.
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(before);
    expect(logs.join('\n')).not.toMatch(/Pruned/);
  });

  it('names the underlying gate error, not a generic refusal string', async () => {
    tmpDir = copyErroredFixture();

    const { errors } = await withCapturedConsole(() => baselinePrune(tmpDir));
    const message = errors.join('\n');
    expect(message).toContain('align baseline prune');
    expect(message).toMatch(/architecture gate/);
    // The gate's own actionable text: which component is empty and how to opt out.
    expect(message).toMatch(/Component 'api'/);
    expect(message).toMatch(/zero files classified/);
  });

  it('still prunes normally on a GREEN verdict (no regression)', async () => {
    tmpDir = copyFixture('simple-app');
    // A stale entry whose file is still present in the scan ⇒ genuinely fixed ⇒ prunable.
    writeBaseline(tmpDir, [
      {
        fingerprint: toViolationId('stale-fixed'),
        ruleId: toRuleId('arch.no-cycles'),
        file: toRepoRelativePath('src/a.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);
    expect(await runCheck(tmpDir, { json: false })).toBe(0);

    const { result: code, logs } = await withCapturedConsole(() => baselinePrune(tmpDir));
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Pruned 1 fixed violation/);
    expect(readBaseline(tmpDir)).toHaveLength(0);
  });

  it('still prunes normally on a RED verdict — red means the violations WERE evaluated', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    const real = readBaseline(tmpDir);
    expect(real).toHaveLength(1);
    // Add a stale entry alongside the real one; the run is red (the real violation still fires).
    writeBaseline(tmpDir, [
      ...real,
      {
        fingerprint: toViolationId('stale-fixed'),
        ruleId: toRuleId('arch.no-dependency:api->ui'),
        file: toRepoRelativePath('src/ui/component.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);

    const { result: code, logs } = await withCapturedConsole(() => baselinePrune(tmpDir));
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Pruned 1 fixed violation/);
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.fingerprint).toBe(real[0]?.fingerprint);
  });
});

describe('the other mutating consumers of a run’s violations', () => {
  it('`align init` refuses on an error verdict instead of writing [] over an existing baseline', async () => {
    tmpDir = copyErroredFixture();
    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');

    const { result: code, errors, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: false, nonInteractive: true, noScripts: true }),
    );

    expect(code).not.toBe(0);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(before);
    expect(logs.join('\n')).not.toMatch(/Initial check is green/);
    expect(errors.join('\n')).toMatch(/Component 'api'/);
  });

  it('`align baseline accept` is safe by construction on an error verdict — it only ever adds', async () => {
    tmpDir = copyErroredFixture();
    const before = readBaseline(tmpDir);
    expect(before).toHaveLength(1);

    const { result: code } = await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    expect(code).toBe(0);
    // The empty violation set makes it a no-op rewrite of the same entries, never a deletion.
    expect(readBaseline(tmpDir)).toEqual(before);
  });
});
