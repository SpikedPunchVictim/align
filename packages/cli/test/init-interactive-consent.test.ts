import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readBaseline, writeBaseline } from '../src/align-dir.js';
import { baselineAccept } from '../src/commands/baseline.js';
import { runInit } from '../src/commands/init.js';
import { toRuleId, toRepoRelativePath, toViolationId } from '@spikedpunch/align-core';

// `InitOptions.confirm` (`commands/init.ts`) is a test-only seam mirroring `UpgradeOptions.confirm`
// (`commands/upgrade.ts`) exactly: supplying it forces `isInteractive` true, independent of
// `nonInteractive`/stdin, so the interactive seed-consent branch can be driven deterministically
// without faking a TTY. Before this seam existed, `init-seed-provenance.test.ts` could only reach
// the non-interactive (`--accept-existing`) path — the `init-seed` stamp, and the interactive
// decline/accept branches, were unreachable from any test. This file covers what that seam unblocks.
// Split into its own file rather than growing an existing one (this repo's own `arch.metric`
// 500-line-per-file rule) — local fixture/console-capture helpers copied per-file, matching every
// sibling test in this directory rather than importing a shared helpers module.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-init-interactive-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  linkAlignCore(dest);
  return dest;
}

/** See `init-incomplete-baseline.test.ts`'s identical helper for the fuller reasoning: a fixture
 * copied to a bare tmpdir has no `node_modules`, so without this symlink `align.config.ts`'s own
 * import of `@spikedpunch/align-core/dsl` would itself read as a `missing-dependencies` advisory. */
function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baselinePath(rootDir: string): string {
  return path.join(rootDir, '.align', 'baseline.json');
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

/** A scripted `confirm` that records every question it was asked, so a test can assert BOTH the
 * answer it returns and whether/how many times it was actually invoked — the call count is itself
 * the assertion for the guard-ordering test below (a guard that refuses before ever asking must
 * leave this at zero calls). */
function trackingConfirm(answer: boolean): { readonly fn: (question: string) => Promise<boolean>; readonly calls: string[] } {
  const calls: string[] = [];
  const fn = async (question: string): Promise<boolean> => {
    calls.push(question);
    return answer;
  };
  return { fn, calls };
}

describe('`align init` interactive baseline-seed consent, via `InitOptions.confirm`', () => {
  it('guard-ordering pin: on an incomplete scan where the seed would drop an existing entry, runInit refuses and NEVER calls confirm — the guard decides whether to even ask', async () => {
    tmpDir = copyFixture('simple-app-violation-incomplete');
    writeBaseline(tmpDir, [
      {
        fingerprint: toViolationId('stale-1'),
        ruleId: toRuleId('arch.no-dependency:api->ui'),
        file: toRepoRelativePath('src/api/service.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);
    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');
    const confirm = trackingConfirm(true);

    const { result: code, errors, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: false, noScripts: true, confirm: confirm.fn }),
    );

    expect(code).not.toBe(0);
    expect(confirm.calls).toHaveLength(0);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(before);
    expect(logs.join('\n')).not.toMatch(/Seeded baseline/);
    expect(errors.join('\n')).toContain('align init');
    expect(errors.join('\n')).toMatch(/refusing to delete 1 entry/);
    expect(errors.join('\n')).toMatch(/--allow-incomplete/);
  });

  it('init-seed stamp pin: on a COMPLETE scan with acceptExisting false, an interactive yes persists a genuinely new violation with acceptedBy "init-seed" and a fresh acceptedAt', async () => {
    tmpDir = copyFixture('simple-app-violation');
    expect(readBaseline(tmpDir)).toHaveLength(0);
    const confirm = trackingConfirm(true);

    const before = Date.now();
    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: false, noScripts: true, confirm: confirm.fn }),
    );
    const after = Date.now();

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Seeded baseline with 1 pre-existing violation/);
    const entries = readBaseline(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.acceptedBy).toBe('init-seed');
    expect(entries[0]?.acceptedAt).toBeGreaterThanOrEqual(before);
    expect(entries[0]?.acceptedAt).toBeLessThanOrEqual(after);
  });

  it('provenance merge on the interactive path: a still-observed entry keeps its prior manual@1700000000000 provenance after an interactive yes', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    const seeded = readBaseline(tmpDir);
    expect(seeded).toHaveLength(1);
    const real = seeded[0]!;
    writeBaseline(tmpDir, [{ ...real, acceptedAt: 1_700_000_000_000, acceptedBy: 'manual' }]);
    const confirm = trackingConfirm(true);

    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: false, noScripts: true, confirm: confirm.fn }),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Seeded baseline with 1 pre-existing violation/);
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.fingerprint).toBe(real.fingerprint);
    expect(after[0]?.acceptedAt).toBe(1_700_000_000_000);
    expect(after[0]?.acceptedBy).toBe('manual');
  });

  it('interactive decline: confirm answering no prints "Not seeding the baseline", exits non-zero, and leaves the baseline byte-for-byte unchanged', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');
    const confirm = trackingConfirm(false);

    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: false, noScripts: true, confirm: confirm.fn }),
    );

    expect(code).not.toBe(0);
    expect(logs.join('\n')).toMatch(/Not seeding the baseline/);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(before);
  });

  it('the prompt is actually reached: confirm is called exactly once, with the un-suffixed question text, on the ordinary consent path', async () => {
    tmpDir = copyFixture('simple-app-violation');
    const confirm = trackingConfirm(true);

    const { result: code } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: false, noScripts: true, confirm: confirm.fn }),
    );

    expect(code).toBe(0);
    expect(confirm.calls).toEqual(['Seed the baseline with these violations now?']);
  });
});
