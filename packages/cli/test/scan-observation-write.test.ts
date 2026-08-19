import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { runDoctor } from '../src/commands/doctor.js';
import { lastScanPath, readLastScanRecord } from '../src/last-scan-file.js';
import { persistScanObservation } from '../src/scan-history.js';
import { noScanHistory, toRepoRelativePath, toRuleId, toViolationId, type CheckRun, type ScanHistoryContext } from '@spikedpunch/align-core';

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

/**
 * ADR 029 §7.6 / LEDGER **D025** — an incomplete run must not overwrite a complete one.
 *
 * §7.5 refuses to write from an ERRORED run. That names one cause of "this run knows less than the
 * repository contains" and misses the other: a merely INCOMPLETE run reports fewer violations (an
 * unresolved specifier drops the edge; an ungrounded component evaluates its rules over nothing), and
 * persisting that narrows the record. The next run then answers `known: true, value: false` about a
 * violation the previous complete scan had seen, so the D015 refusal does not fire — disarmed by one
 * `align check` run without dependencies installed, and silently.
 *
 * **Driven through `persistScanObservation` with hand-built runs rather than through `runCheck`, and
 * the reason is a measurement worth recording.** Every fixture in this suite is PERMANENTLY
 * incomplete: `simple-app-violation` has no `node_modules`, so every `align check` on it emits
 * `missing-dependencies` and `isRunComplete` is false (measured 2026-08-18 — the first draft of these
 * tests assumed the opposite and three of them failed). A complete→incomplete transition therefore
 * cannot be produced from these fixtures at all, and manufacturing one would mean symlinking a real
 * `node_modules` in, which tests the loader rather than the guard. The end-to-end direction that CAN
 * be reached — an incomplete run bootstrapping and then tracking the repository — is covered by every
 * other test in this file, all of which run incomplete.
 */
describe('an incomplete scan does not replace a complete record (ADR 029 §7.6)', () => {
  function runWith(complete: boolean, files: readonly string[]): CheckRun {
    return {
      verdict: 'green',
      gates: [],
      // The same lever `refuseIfRunIncomplete`'s own unit tests use (`errored-run-mutations.test.ts`),
      // so both consumers of `isRunComplete` are driven the same way.
      advisories: complete ? [] : [{ kind: 'missing-dependencies', message: 'deps missing' }],
      scannedAt: 1_755_000_000_000,
      ungroundedComponents: [],
      blindSpots: [],
      observedFiles: { source: new Set(files.map(toRepoRelativePath)), manifest: new Set() },
      observedViolations: files.map((file) => ({
        file: toRepoRelativePath(file),
        ruleId: toRuleId('r1'),
        contentFingerprint: toViolationId('cf1'),
      })),
      componentMatchCounts: new Map(),
    };
  }

  const context = (): ScanHistoryContext => ({
    alignVersion: '0.2.0',
    scopeIdentity: 'scope-1',
    ruleDefinitions: new Map([[toRuleId('r1'), 'h1']]),
    componentSelectorIdentities: new Map(),
  });

  /** Persist one run against whatever is on disk, the way a command does: read, then write. */
  function persist(dir: string, run: CheckRun): void {
    persistScanObservation(dir, run, { probe: noScanHistory(), context: context(), previous: readLastScanRecord(dir) });
  }

  it('bootstraps from an incomplete run when there is no record at all', () => {
    // An incomplete record beats none: every question it answers `true` is still a sound positive
    // observation. Declining here is what would make the mechanism permanently inert on a repository
    // that is always incomplete — the integration project reports `complete: false` at its pinned
    // commit (48 unresolved specifiers), so that is the normal case and not a corner one.
    const dir = copyFixture('simple-app-violation');

    persist(dir, runWith(false, ['src/a.ts']));

    expect(readLastScanRecord(dir)?.complete).toBe(false);
    expect(readLastScanRecord(dir)?.violations.map((v) => v.file)).toEqual(['src/a.ts']);
  });

  it('still tracks the repository across two incomplete scans', () => {
    // Calibration [S-05]: a guard that declined every incomplete write would satisfy the test below
    // while freezing the record permanently on any repository that is never complete.
    const dir = copyFixture('simple-app-violation');
    persist(dir, runWith(false, ['src/a.ts']));

    persist(dir, runWith(false, ['src/b.ts']));

    expect(readLastScanRecord(dir)?.violations.map((v) => v.file)).toEqual(['src/b.ts']);
  });

  it('upgrades an incomplete record when the scan becomes complete', () => {
    const dir = copyFixture('simple-app-violation');
    persist(dir, runWith(false, ['src/a.ts']));

    persist(dir, runWith(true, ['src/a.ts', 'src/b.ts']));

    expect(readLastScanRecord(dir)?.complete).toBe(true);
    expect(readLastScanRecord(dir)?.violations).toHaveLength(2);
  });

  it('KEEPS the complete record when the next scan is incomplete, and says so', () => {
    // The defect, in one sequence. Asserted on the recorded VIOLATIONS and not just on the flag: a
    // stale flag would be cosmetic, whereas losing the violation is what disarms the D015 refusal.
    const dir = copyFixture('simple-app-violation');
    persist(dir, runWith(true, ['src/a.ts', 'src/b.ts']));
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    persist(dir, runWith(false, ['src/a.ts']));

    const after = readLastScanRecord(dir);
    expect(after?.complete).toBe(true);
    expect(after?.violations.map((v) => v.file)).toEqual(['src/a.ts', 'src/b.ts']);
    // Loud, not silent: a mechanism that has stopped tracking the repository must say so, or the next
    // person to look concludes from the absence of complaint that it is up to date.
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('kept rather than replaced'));
  });
});
