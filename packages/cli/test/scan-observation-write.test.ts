import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { runDoctor } from '../src/commands/doctor.js';
import { lastScanPath, readLastScanRecord } from '../src/last-scan-file.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-scan-history-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return (tmpDir = dest);
}

/** Silences the CLI's own stdout for a check, so the suite's output is assertions rather than
 * rendered violation reports. */
async function quietCheck(dir: string, options: Parameters<typeof runCheck>[1] = { json: false }): Promise<number> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await runCheck(dir, options);
  } finally {
    process.stdout.write = original;
  }
}

describe('align check records what it observed (ADR 029 §7)', () => {
  it('writes .align/last-scan.json on a plain check, with both domains and the violation it found', async () => {
    const dir = copyFixture('simple-app-violation');

    expect(await quietCheck(dir)).toBe(1);

    const record = readLastScanRecord(dir);
    expect(record?.recordVersion).toBe(1);
    expect(record?.observed.source).toContain('src/api/service.ts');
    // The violation is recorded even though it is unbaselined and red — the record is what the scan
    // OBSERVED, not what a human still owes a decision on.
    expect(record?.violations.map((v) => v.file)).toEqual(['src/api/service.ts']);
    expect(record?.components['api']?.matchCount).toBe(1);
  });

  it('does not rewrite the record when the second check observes the same thing (§7.1)', async () => {
    // The property that keeps a write off the hot path of a command people put in pre-commit hooks.
    // Asserted on INODE rather than mtime: mtime has one-second granularity on some filesystems, so
    // two writes inside one test can share a timestamp and the assertion would pass vacuously —
    // whereas `writeFileAtomic` installs a new inode on every write, by construction.
    const dir = copyFixture('simple-app-violation');
    await quietCheck(dir);
    const first = fs.statSync(lastScanPath(dir)).ino;

    await quietCheck(dir);

    expect(fs.statSync(lastScanPath(dir)).ino).toBe(first);
  });

  it('DOES rewrite it once the repository changes', async () => {
    // Calibration for the test above: a writer that never wrote twice would satisfy it while leaving
    // the history permanently stuck on the first scan align ever ran.
    const dir = copyFixture('simple-app-violation');
    await quietCheck(dir);
    const first = fs.statSync(lastScanPath(dir)).ino;
    fs.renameSync(path.join(dir, 'src/api/service.ts'), path.join(dir, 'src/api/renamed.ts'));

    await quietCheck(dir);

    expect(fs.statSync(lastScanPath(dir)).ino).not.toBe(first);
    expect(readLastScanRecord(dir)?.observed.source).toContain('src/api/renamed.ts');
  });

  it('never writes from an ERRORED run — "knows nothing" must not become "observed nothing"', async () => {
    // An errored run reports empty observed files, violations and match counts by design
    // (`untrustworthyScanScope`). Persisting that would convert the absence of knowledge into the
    // positive claim that the previous scan saw nothing, which IS admissible next run — and would
    // read a component that matched 12 files as having always matched 0, silencing the regression
    // ADR 029 §6 exists to report. It would also destroy a sound record to do it.
    //
    // Not in ADR 029 §7 as written; added by this implementation and amended into the ADR.
    const dir = copyFixture('simple-app-violation');
    await quietCheck(dir);
    const good = readLastScanRecord(dir);
    expect(good).toBeDefined();

    // A component that classifies zero files is a guard-step error (`validateClassifiedComponents`),
    // which is a verdict:'error' run rather than a red one.
    fs.rmSync(path.join(dir, 'src/ui'), { recursive: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await quietCheck(dir)).toBe(1);

    expect(readLastScanRecord(dir)).toEqual(good);
  });

  it('a failed write does not fail the check (§7.2)', async () => {
    // Read-only checkouts and sandboxed CI are ordinary. A `check` that exited non-zero because it
    // could not update a cache would be a worse outcome than the staleness it was avoiding.
    const dir = copyFixture('simple-app-violation');
    // A DIRECTORY where the record wants to be: every write against it fails, at every attempt.
    fs.mkdirSync(lastScanPath(dir), { recursive: true });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await quietCheck(dir)).toBe(1); // the fixture's own violation, not the write failure

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('.align/last-scan.json'));
  });

  it('`align check --untrusted` records it too, from the committed IR artifact\'s scope', async () => {
    const dir = copyFixture('simple-app-violation');
    const { runExportIr } = await import('../src/commands/export-ir.js');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runExportIr(dir, {})).toBe(0);

    expect(await quietCheck(dir, { json: false, untrusted: true })).toBe(1);

    expect(readLastScanRecord(dir)?.observed.source).toContain('src/api/service.ts');
  });
});

/**
 * ADR 029 §7.3's damage argument, pinned. A surface that scans without making a transfer decision
 * must not move the temporal reference forward: run `align doctor` after a rename and, if it wrote,
 * the record would already show the violation at its new path — so the next `align check` would
 * refuse a legitimate rename. `doctor` stands in for the whole set, which is `explain`, `build`,
 * `init`, `agent run`, `upgrade`, `baseline accept`, `baseline show` and `baseline prune` — all of
 * which scan and none of which writes. (The `baseline` three were missing from this list until
 * adversarial review 2026-08-18, and `baseline prune` is the interesting omission: it CONSULTS the
 * record for a transfer decision, because `store.prune` runs `applyMoves`, and still does not write.
 * That makes it a second counter-example to ADR 029 §7.3's original "if and only if", alongside
 * `upgrade` — which is why the rule is now `write ⇒ consulted`.)
 */
describe('only a surface that made a transfer decision writes the record', () => {
  it('align doctor scans but records nothing', async () => {
    const dir = copyFixture('simple-app-violation');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runDoctor(dir, { json: false })).toBe(0);

    expect(fs.existsSync(lastScanPath(dir))).toBe(false);
  });

  it('and does not overwrite one a check already wrote', async () => {
    // The half that actually bites: `doctor` creating the file is visible, `doctor` silently
    // advancing it is not.
    const dir = copyFixture('simple-app-violation');
    await quietCheck(dir);
    const before = fs.statSync(lastScanPath(dir)).ino;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runDoctor(dir, { json: false });

    expect(fs.statSync(lastScanPath(dir)).ino).toBe(before);
  });
});
