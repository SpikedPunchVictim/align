import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALIGN_LOCAL_GITIGNORE_ENTRIES, ensureAlignLocalFilesGitignored } from '../src/init/gitignore.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tmp(existing?: string): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-gitignore-'));
  if (existing !== undefined) fs.writeFileSync(path.join(tmpDir, '.gitignore'), existing, 'utf8');
  return tmpDir;
}

function gitignoreOf(dir: string): string {
  return fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
}

/**
 * Driven by `ALIGN_LOCAL_GITIGNORE_ENTRIES` rather than by the entry names, which is the change ADR
 * 029 forced: this suite named `.align/telemetry.jsonl` and `.align/telemetry-state.json` in five
 * places, so adding `.align/last-scan.json` broke one test and — far worse — left the other four
 * green while covering two thirds of the list. An entry added without a test is exactly the
 * omission that matters here, because a machine-local record that gets COMMITTED is ADR 029 §1's
 * stated correctness failure, not a tidiness one.
 */
describe('ensureAlignLocalFilesGitignored', () => {
  it('creates .gitignore with every machine-local entry when none exists', () => {
    const dir = tmp();
    expect(ensureAlignLocalFilesGitignored(dir)).toBe(true);
    for (const entry of ALIGN_LOCAL_GITIGNORE_ENTRIES) expect(gitignoreOf(dir)).toContain(entry);
  });

  it('includes the scan-observation record, which is gitignored for identity and not for churn', () => {
    // Named explicitly as well as covered by the loop above: the loop proves the list is honoured,
    // this proves the list is right. ADR 029 §1 — a record written on machine A is not evidence
    // about machine B's checkout, so committing it would let one machine's observation authorize
    // another machine's deletion.
    expect(ALIGN_LOCAL_GITIGNORE_ENTRIES).toContain('.align/last-scan.json');
  });

  it('appends entries to an existing .gitignore without disturbing its content', () => {
    const dir = tmp('node_modules/\ndist/\n');
    expect(ensureAlignLocalFilesGitignored(dir)).toBe(true);
    expect(gitignoreOf(dir)).toContain('node_modules/');
    expect(gitignoreOf(dir)).toContain('dist/');
    for (const entry of ALIGN_LOCAL_GITIGNORE_ENTRIES) expect(gitignoreOf(dir)).toContain(entry);
  });

  it('is idempotent — a second call is a no-op and never duplicates entries', () => {
    const dir = tmp();
    ensureAlignLocalFilesGitignored(dir);
    expect(ensureAlignLocalFilesGitignored(dir)).toBe(false);
    for (const entry of ALIGN_LOCAL_GITIGNORE_ENTRIES) expect(gitignoreOf(dir).split(entry).length - 1).toBe(1);
  });

  it('does nothing when every entry is already present (e.g. hand-authored)', () => {
    expect(ensureAlignLocalFilesGitignored(tmp(`${ALIGN_LOCAL_GITIGNORE_ENTRIES.join('\n')}\n`))).toBe(false);
  });

  it('appends only the MISSING entries when the file is partially populated', () => {
    // The upgrade path, and the one this suite had no coverage for at all: a repository that ran
    // `align init` before ADR 029 has the two telemetry lines and not the third. Appending the whole
    // block would duplicate the first two.
    const [first, ...rest] = ALIGN_LOCAL_GITIGNORE_ENTRIES;
    // Not a defensive check: it pins the assumption this test rests on, so a future list of one
    // entry fails here loudly instead of turning the assertions below into a comparison of nothing.
    expect(rest.length).toBeGreaterThan(0);
    const dir = tmp(`${first}\n`);

    expect(ensureAlignLocalFilesGitignored(dir)).toBe(true);

    expect(gitignoreOf(dir).split(first).length - 1).toBe(1);
    for (const entry of rest) expect(gitignoreOf(dir)).toContain(entry);
  });

  it('never blanket-ignores .align/ itself', () => {
    // Most `.align/*` artifacts (baseline.json above all) are committed consent records. A blanket
    // ignore would silently stop a team sharing them, and nothing downstream would report it.
    const dir = tmp();
    ensureAlignLocalFilesGitignored(dir);
    const lines = gitignoreOf(dir).split('\n').map((l) => l.trim());
    expect(lines).not.toContain('.align/');
    expect(lines).not.toContain('.align');
  });
});
