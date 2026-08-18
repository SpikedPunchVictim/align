import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBaseline, readBaselineSnapshot, writeBaseline } from '../src/align-dir.js';
import type { BaselineEntry, RepoRelativePath, RuleId, ViolationId } from '@spikedpunch/align-core';

let dir: string;

afterEach(() => {
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  return (dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'align-concurrent-'))));
}

function entry(name: string): BaselineEntry {
  return {
    fingerprint: `fp-${name}` as ViolationId,
    ruleId: 'arch.no-dependency:a->b' as RuleId,
    file: `src/${name}.ts` as RepoRelativePath,
    acceptedAt: 1_700_000_000_000,
    acceptedBy: 'manual',
  };
}

function names(rootDir: string): string[] {
  return readBaseline(rootDir)
    .map((e) => e.fingerprint as string)
    .sort();
}

/**
 * ADR 030. The defect: `writeBaseline` is a full-snapshot REPLACE with no merge, and every
 * destructive command wraps it in a read-modify-write whose middle is a scan taking seconds. Two
 * aligns overlapping in that window — an MCP server and a human's `align baseline accept` is the
 * case that actually happens — meant the second write erased the first, and both reported success.
 * A destroyed consent decision at exit 0 is this project's severity zero.
 */
describe('writeBaseline refuses a write computed from a baseline that has since changed (ADR 030)', () => {
  it('writes normally when nothing else touched the file', () => {
    const d = repo();
    const before = readBaselineSnapshot(d);

    writeBaseline(d, [entry('a')], before.token);

    expect(names(d)).toEqual(['fp-a']);
  });

  it('REFUSES, and preserves the other process\'s entries, when the baseline moved underneath', () => {
    const d = repo();
    // Process 1 reads an empty repo and begins a long scan.
    const stale = readBaselineSnapshot(d);
    expect(stale.token).toBeUndefined();

    // Process 2 finishes first and records a human's acceptance.
    writeBaseline(d, [entry('accepted-by-someone-else')], readBaselineSnapshot(d).token);

    // Process 1 now writes what it computed. Before ADR 030 this silently replaced the file and the
    // other decision was gone, at exit 0, with nothing reported anywhere.
    expect(() => writeBaseline(d, [entry('a')], stale.token)).toThrow(/changed while this command was running/);

    // The assertion that matters: the other process's work is intact and this write did not land.
    expect(names(d)).toEqual(['fp-accepted-by-someone-else']);
  });

  it('distinguishes "there was no baseline" from "the baseline is empty"', () => {
    const d = repo();
    const noFile = readBaselineSnapshot(d);
    expect(noFile.token).toBeUndefined();

    // A racing `init` creates an EMPTY baseline. If `undefined` were treated as "no expectation"
    // rather than as a real token, this stale write would sail through and clobber it — and because
    // both states read back as zero entries, nothing downstream could ever tell.
    writeBaseline(d, [], readBaselineSnapshot(d).token);
    expect(fs.existsSync(path.join(d, '.align', 'baseline.json'))).toBe(true);

    expect(() => writeBaseline(d, [entry('a')], noFile.token)).toThrow(/changed while this command was running/);
  });

  it('a rewrite of identical content is not a conflict — the token follows bytes, not writes', () => {
    const d = repo();
    writeBaseline(d, [entry('a')], readBaselineSnapshot(d).token);
    const snapshot = readBaselineSnapshot(d);

    // Someone else wrote, but wrote exactly what was already there. Nothing was lost, so refusing
    // would be a false alarm — and false alarms on a safety check are how the check gets disabled.
    writeBaseline(d, [entry('a')], readBaselineSnapshot(d).token);

    expect(() => writeBaseline(d, [entry('a'), entry('b')], snapshot.token)).not.toThrow();
    expect(names(d)).toEqual(['fp-a', 'fp-b']);
  });

  it('leaves no lock behind after a refusal', () => {
    const d = repo();
    const stale = readBaselineSnapshot(d);
    writeBaseline(d, [entry('x')], readBaselineSnapshot(d).token);

    expect(() => writeBaseline(d, [entry('a')], stale.token)).toThrow();

    // The refusal throws from INSIDE the lock's body. A lock leaked there would block every later
    // align in the repository for the full timeout.
    expect(fs.existsSync(path.join(d, '.align', '.lock'))).toBe(false);
  });

  it('is calibrated: the guard is what refuses, not some unrelated failure', () => {
    const d = repo();
    const stale = readBaselineSnapshot(d);
    writeBaseline(d, [entry('x')], readBaselineSnapshot(d).token);

    // Same call, same everything, differing only in the token — one throws and one does not. Without
    // this pairing the test above would pass if `writeBaseline` were broken outright (shape S-05).
    expect(() => writeBaseline(d, [entry('a')], stale.token)).toThrow();
    expect(() => writeBaseline(d, [entry('a')], readBaselineSnapshot(d).token)).not.toThrow();
    expect(names(d)).toEqual(['fp-a']);
  });
});
