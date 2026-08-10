import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readVersionFile } from '../src/align-dir.js';
import { versionFileSchema } from '../src/version-file.js';

// ADR 022 (`.align/version.json`) — `readVersionFile` is the one reader both the write-side
// stamping choke point (`stampAlignVersion`/`recordBaselineReconciled`, `align-dir.ts`) and the `align
// check` provenance advisory (`version-skew.ts`) share. These tests pin its contract directly,
// mirroring `artifact-schema-errors.test.ts`'s BUG #16 coverage for the other three artifact
// readers (`readBaseline`/`readGeneratedRules`/`readRulesetIr`): absent is never an error, but a
// PRESENT file that fails to parse — as JSON or against the schema — always throws a readable
// message naming the file, never silently read as "absent".

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-version-file-test-'));
  fs.mkdirSync(path.join(dir, '.align'), { recursive: true });
  return dir;
}

function writeVersionJson(rootDir: string, contents: string): void {
  fs.writeFileSync(path.join(rootDir, '.align', 'version.json'), contents, 'utf8');
}

/** Mirrors `artifact-schema-errors.test.ts`'s helper: a raw zod dump looks like
 * `[ { "code": "invalid_type", ... } ]` or mentions "ZodError" — neither should ever reach a
 * thrown error's `.message`. */
function looksLikeRawZodDump(message: string): boolean {
  return /ZodError/.test(message) || /"code":\s*"invalid_type"/.test(message) || /"expected":/.test(message);
}

describe('versionFileSchema', () => {
  it('accepts { alignVersion } alone — baselineReconciledBy is optional', () => {
    const result = versionFileSchema.safeParse({ alignVersion: '0.2.0' });
    expect(result.success).toBe(true);
  });

  it('accepts { alignVersion, baselineReconciledBy }', () => {
    const result = versionFileSchema.safeParse({ alignVersion: '0.2.0', baselineReconciledBy: '0.2.0' });
    expect(result.success).toBe(true);
  });

  it('rejects a missing alignVersion', () => {
    expect(versionFileSchema.safeParse({ baselineReconciledBy: '0.2.0' }).success).toBe(false);
  });

  it('preserves unknown keys (.passthrough()) — a forward-compat field from a newer align round-trips', () => {
    const result = versionFileSchema.safeParse({ alignVersion: '0.2.0', someFutureField: 'xyz' });
    expect(result.success).toBe(true);
    expect(result.success && (result.data as { someFutureField?: unknown }).someFutureField).toBe('xyz');
  });
});

describe('readVersionFile', () => {
  it('missing file: returns undefined, never throws (absence is a legitimate "predates stamping" state)', () => {
    tmpDir = makeRepo();
    expect(readVersionFile(tmpDir)).toBeUndefined();
  });

  it('present + valid: parses both fields', () => {
    tmpDir = makeRepo();
    writeVersionJson(tmpDir, JSON.stringify({ alignVersion: '0.1.4', baselineReconciledBy: '0.1.4' }));
    expect(readVersionFile(tmpDir)).toEqual({ alignVersion: '0.1.4', baselineReconciledBy: '0.1.4' });
  });

  it('present + valid, alignVersion only: baselineReconciledBy is simply absent from the result', () => {
    tmpDir = makeRepo();
    writeVersionJson(tmpDir, JSON.stringify({ alignVersion: '0.1.4' }));
    expect(readVersionFile(tmpDir)).toEqual({ alignVersion: '0.1.4' });
  });

  it('present + unknown keys: preserved on read, not stripped', () => {
    tmpDir = makeRepo();
    writeVersionJson(tmpDir, JSON.stringify({ alignVersion: '0.1.4', futureField: 'abc' }));
    const result = readVersionFile(tmpDir) as { alignVersion: string; futureField?: string };
    expect(result.alignVersion).toBe('0.1.4');
    expect(result.futureField).toBe('abc');
  });

  it('present + corrupt JSON: throws, message names the file, matches the other readers\' phrasing', () => {
    tmpDir = makeRepo();
    writeVersionJson(tmpDir, '{ not valid json');
    let thrown: unknown;
    try {
      readVersionFile(tmpDir);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(path.join(tmpDir, '.align', 'version.json'));
    expect(message).toMatch(/is not valid JSON/);
  });

  it('present + schema-invalid (valid JSON, wrong shape): throws a readable message naming the file, not a raw ZodError', () => {
    tmpDir = makeRepo();
    writeVersionJson(tmpDir, JSON.stringify({ alignVersion: 123 })); // wrong type
    let thrown: unknown;
    try {
      readVersionFile(tmpDir);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(path.join(tmpDir, '.align', 'version.json'));
    expect(looksLikeRawZodDump(message)).toBe(false);
  });

  it('present + schema-invalid (missing alignVersion entirely): throws', () => {
    tmpDir = makeRepo();
    writeVersionJson(tmpDir, JSON.stringify({ baselineReconciledBy: '0.1.4' }));
    expect(() => readVersionFile(tmpDir)).toThrow();
  });
});
