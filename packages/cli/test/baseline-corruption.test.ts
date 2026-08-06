import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readBaseline, writeBaseline } from '../src/align-dir.js';
import { baselineAccept, baselinePrune, baselineShow } from '../src/commands/baseline.js';
import { runCheck } from '../src/commands/check.js';
import { toRuleId, toRepoRelativePath, toViolationId, type BaselineEntry } from '@spikedpunch/align-core';

// Bug hunt 2026-08-03, BUG #1: `.align/baseline.json` is a committed file multiple developers
// append to via `align baseline accept`; a git merge conflict left unresolved inside it used to be
// silently read as `[]` (readBaseline swallowed both the JSON.parse failure and a non-array root),
// which made `align check` report every accepted violation as new, and the natural next step —
// `align baseline accept` — would rebuild the store from that silent `[]` and overwrite the file,
// permanently destroying every previously-accepted entry. The fix: `readBaseline` now throws on a
// corrupted file instead of returning `[]`, and every caller surfaces that throw as a clean,
// non-zero exit instead of a raw Node stack trace or (worse) a silent overwrite.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-cli-baseline-corruption-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function withCapturedConsole<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  // eslint-disable-next-line no-console
  console.log = ((...args: unknown[]) => logs.push(args.map(String).join(' '))) as typeof console.log;
  // eslint-disable-next-line no-console
  console.error = ((...args: unknown[]) => errors.push(args.map(String).join(' '))) as typeof console.error;
  try {
    const result = await run();
    return { result, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const MERGE_CONFLICT_BASELINE =
  '[\n' +
  '<<<<<<< HEAD\n' +
  '  { "fingerprint": "f1", "ruleId": "arch.metric:loc:ui", "file": "src/ui/big.ts", "acceptedAt": 1, "acceptedBy": "manual" }\n' +
  '=======\n' +
  '  { "fingerprint": "f2", "ruleId": "arch.no-dependency:api->ui", "file": "src/api/service.ts", "acceptedAt": 2, "acceptedBy": "manual" }\n' +
  '>>>>>>> feature-branch\n' +
  ']\n';

function baselinePath(rootDir: string): string {
  return path.join(rootDir, '.align', 'baseline.json');
}

function writeCorruptBaseline(rootDir: string, contents: string): void {
  fs.mkdirSync(path.join(rootDir, '.align'), { recursive: true });
  fs.writeFileSync(baselinePath(rootDir), contents, 'utf8');
}

describe('readBaseline — corrupt-input discipline (mirrors readRulesetIr, diverges from readTelemetryState)', () => {
  it('missing file still returns [] (unchanged behavior)', () => {
    tmpDir = copyFixture('simple-app');
    expect(readBaseline(tmpDir)).toEqual([]);
  });

  it('throws on invalid JSON containing unresolved git merge-conflict markers, naming the merge-conflict cause', () => {
    tmpDir = copyFixture('simple-app');
    writeCorruptBaseline(tmpDir, MERGE_CONFLICT_BASELINE);
    expect(() => readBaseline(tmpDir)).toThrow(/merge conflict/i);
  });

  it('throws on a non-array JSON root (e.g. {})', () => {
    tmpDir = copyFixture('simple-app');
    writeCorruptBaseline(tmpDir, JSON.stringify({ not: 'an array' }));
    expect(() => readBaseline(tmpDir)).toThrow();
  });

  it('never treats a corrupted file as empty — the message says so explicitly', () => {
    tmpDir = copyFixture('simple-app');
    writeCorruptBaseline(tmpDir, '{ this is not valid json at all');
    expect(() => readBaseline(tmpDir)).toThrow(/never (be )?treated as empty|never treated as empty/i);
  });

  it('back-compat: a legacy on-disk file with entries missing contentFingerprint still reads fine', () => {
    tmpDir = copyFixture('simple-app');
    const legacy: Omit<BaselineEntry, 'contentFingerprint'>[] = [
      { fingerprint: toViolationId('f1'), ruleId: toRuleId('arch.no-cycles'), file: toRepoRelativePath('src/a.ts'), acceptedAt: 1, acceptedBy: 'init-seed' },
    ];
    writeCorruptBaseline(tmpDir, JSON.stringify(legacy));
    const entries = readBaseline(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.contentFingerprint).toBeUndefined();
  });

  it('an on-disk entry carrying an unknown extra key still reads fine', () => {
    tmpDir = copyFixture('simple-app');
    writeCorruptBaseline(
      tmpDir,
      JSON.stringify([
        { fingerprint: 'f1', ruleId: 'arch.no-cycles', file: 'src/a.ts', acceptedAt: 1, acceptedBy: 'manual', futureField: 'kept' },
      ]),
    );
    const entries = readBaseline(tmpDir);
    expect(entries).toHaveLength(1);
    expect((entries[0] as unknown as Record<string, unknown>).futureField).toBe('kept');
  });
});

describe('a corrupted baseline is never destroyed by `align baseline accept` (the data-loss regression)', () => {
  it('bare `align baseline accept` refuses and leaves the on-disk bytes byte-for-byte unchanged', async () => {
    tmpDir = copyFixture('simple-app-violation');
    // Seed a real baseline first, then corrupt it — simulating an unresolved merge conflict in a
    // file that already held real, irreplaceable consent decisions.
    writeBaseline(tmpDir, [
      { fingerprint: toViolationId('real-entry'), ruleId: toRuleId('arch.layers:api'), file: toRepoRelativePath('src/api/service.ts'), acceptedAt: 1, acceptedBy: 'manual' },
    ]);
    writeCorruptBaseline(tmpDir, MERGE_CONFLICT_BASELINE);
    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');

    const { result: code, errors } = await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    expect(code).toBe(1);
    expect(errors.join('\n').length).toBeGreaterThan(0);

    const after = fs.readFileSync(baselinePath(tmpDir), 'utf8');
    expect(after).toBe(before); // byte-for-byte — not merely "an error was reported"
  });

  it('`align baseline accept --rule X` (the equally-destructive scoped path) also refuses without overwriting', async () => {
    tmpDir = copyFixture('simple-app-violation');
    writeCorruptBaseline(tmpDir, MERGE_CONFLICT_BASELINE);
    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');

    const { result: code } = await withCapturedConsole(() => baselineAccept(tmpDir, 'arch.layers:api'));
    expect(code).toBe(1);

    const after = fs.readFileSync(baselinePath(tmpDir), 'utf8');
    expect(after).toBe(before);
  });

  it('`align baseline prune` also refuses without overwriting the corrupted file', async () => {
    tmpDir = copyFixture('simple-app-violation');
    writeCorruptBaseline(tmpDir, MERGE_CONFLICT_BASELINE);
    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');

    const { result: code } = await withCapturedConsole(() => baselinePrune(tmpDir));
    expect(code).toBe(1);

    const after = fs.readFileSync(baselinePath(tmpDir), 'utf8');
    expect(after).toBe(before);
  });

  it('`align baseline show` refuses cleanly too (read-only, but still must not crash raw)', async () => {
    tmpDir = copyFixture('simple-app-violation');
    writeCorruptBaseline(tmpDir, MERGE_CONFLICT_BASELINE);

    const { result: code, errors } = await withCapturedConsole(() => baselineShow(tmpDir, undefined));
    expect(code).toBe(1);
    expect(errors.join('\n').length).toBeGreaterThan(0);
  });
});

describe('caller sweep — every readBaseline caller surfaces a clean non-zero exit, never a raw throw', () => {
  it('`align check` (trusted) reports a clean error and exit 1 on a corrupted baseline', async () => {
    tmpDir = copyFixture('simple-app-violation');
    writeCorruptBaseline(tmpDir, MERGE_CONFLICT_BASELINE);

    const { result: code, errors } = await withCapturedConsole(() => runCheck(tmpDir, { json: false }));
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/baseline\.json/);
  });
});
