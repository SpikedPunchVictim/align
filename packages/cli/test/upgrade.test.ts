import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { toRepoRelativePath, toRuleId, toViolationId } from '@spikedpunch/align-core';
import { ensureAlignDir, readBaseline, readVersionFile } from '../src/align-dir.js';
import { baselineAccept } from '../src/commands/baseline.js';
import { runCheck } from '../src/commands/check.js';
import { runUpgrade } from '../src/commands/upgrade.js';
import { ALIGN_VERSION } from '../src/telemetry/process-context.js';
import { seedBaseline } from './seed-baseline.js';

// `align upgrade` (ADR 022, task #16 slice D): a consent-gated wrapper over the existing
// prune/check/accept flow. These tests exercise the flow end to end against real fixtures (the
// same `simple-app*` family `errored-run-mutations.test.ts` uses for the ADR 023 refusal tiers),
// plus the consent/stamping rules ADR 022 specifies precisely: stamp LAST, never on `--notes` or a
// refusal, never on partial consent.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Every fixture's `align.config.ts` imports `@spikedpunch/align-core/dsl`; a fixture copied to a
 * bare tmpdir has no `node_modules`, so this symlinks the real built core package in — mirrors a
 * real install and keeps scans `complete: true` unless a fixture deliberately adds its own
 * unresolvable import (`simple-app-violation-incomplete`). Same technique as
 * `errored-run-mutations.test.ts`'s `linkAlignCore`. */
function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-upgrade-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  linkAlignCore(dest);
  return dest;
}

/** `simple-app-violation` (`api` cannotDependOn `ui`, genuinely violated) shadowed by an earlier,
 * broader component — first-match-wins classification leaves `api` with zero files, which
 * `validateClassifiedComponents` reports as an ERRORED architecture gate. Same construction as
 * `errored-run-mutations.test.ts`'s `copyErroredFixture`. */
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
  return dest;
}

function copyIncompleteFixture(): string {
  return copyFixture('simple-app-violation-incomplete');
}

function baselinePath(rootDir: string): string {
  return path.join(rootDir, '.align', 'baseline.json');
}

function versionPath(rootDir: string): string {
  return path.join(rootDir, '.align', 'version.json');
}

/** Writes `.align/baseline.json` directly, bypassing `align-dir.ts`'s `writeBaseline` — that
 * function ALWAYS stamps `alignVersion` to the currently-running version as a side effect (ADR
 * 022's write-discipline choke point), which is exactly wrong for a test that needs to start from
 * "no version.json at all." Same on-disk shape `writeBaseline` produces otherwise. */
function writeBaselineRaw(rootDir: string, entries: readonly ReturnType<typeof staleEntry>[]): void {
  ensureAlignDir(rootDir);
  fs.writeFileSync(baselinePath(rootDir), `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

function writeVersionStamp(rootDir: string, alignVersion: string, baselineReconciledBy?: string): void {
  ensureAlignDir(rootDir);
  fs.writeFileSync(
    versionPath(rootDir),
    JSON.stringify(baselineReconciledBy === undefined ? { alignVersion } : { alignVersion, baselineReconciledBy }, null, 2) + '\n',
    'utf8',
  );
}

/** A stale baseline entry — its file (`src/api/service.ts`) is present in every fixture's scan, but
 * its fingerprint matches no current violation, so `store.prune` classifies it as `removed`
 * (genuinely fixed), never `moved`. Exactly the shape `align upgrade`'s prune half should offer to
 * remove. */
function staleEntry() {
  return {
    fingerprint: toViolationId('stale-orphaned-entry'),
    ruleId: toRuleId('arch.no-dependency:api->ui'),
    file: toRepoRelativePath('src/api/service.ts'),
    acceptedAt: 1,
    acceptedBy: 'manual' as const,
  };
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

const alwaysYes = async (): Promise<boolean> => true;
const alwaysNo = async (): Promise<boolean> => false;

describe('align upgrade — happy path', () => {
  it('consents to both prune and accept, reconciles the baseline, and stamps both fields', async () => {
    tmpDir = copyFixture('simple-app-violation');
    seedBaseline(tmpDir, [staleEntry()]); // orphaned — the real api->ui violation is NOT yet baselined
    writeVersionStamp(tmpDir, '0.1.0');

    const { result: code, logs } = await withCapturedConsole(() =>
      runUpgrade(tmpDir, { nonInteractive: false, confirm: alwaysYes }),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('align upgrade: 0.1.0 → ' + ALIGN_VERSION);
    expect(logs.join('\n')).toMatch(/Reconciled — baseline is now recorded as reconciled/);

    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.fingerprint).not.toBe(toViolationId('stale-orphaned-entry')); // stale entry pruned

    const stamp = readVersionFile(tmpDir);
    expect(stamp?.alignVersion).toBe(ALIGN_VERSION);
    expect(stamp?.baselineReconciledBy).toBe(ALIGN_VERSION);

    // The real violation is now tolerated — check is green.
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
  });

  it('`--yes` reconciles fully non-interactively, without any prompt', async () => {
    tmpDir = copyFixture('simple-app-violation');
    seedBaseline(tmpDir, [staleEntry()]);
    writeVersionStamp(tmpDir, '0.1.0'); // writeBaseline above already stamped alignVersion=current; override it back

    const code = await runUpgrade(tmpDir, { nonInteractive: true, yes: true });

    expect(code).toBe(0);
    expect(readBaseline(tmpDir)).toHaveLength(1);
    expect(readVersionFile(tmpDir)?.baselineReconciledBy).toBe(ALIGN_VERSION);
  });

  it('a baseline already in agreement with the current check stamps trivially (verification IS the work)', async () => {
    tmpDir = copyFixture('simple-app-violation');
    // Seed the baseline for real (accept the pre-existing violation), then simulate that this was
    // reconciled under an older version — otherwise `writeBaseline`'s own `alignVersion` stamp would
    // already read as "current" and this test would never exercise the reconciliation path at all.
    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    expect(readBaseline(tmpDir)).toHaveLength(1);
    writeVersionStamp(tmpDir, '0.1.0');

    const { result: code, logs } = await withCapturedConsole(() => runUpgrade(tmpDir, { nonInteractive: true, yes: true }));
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/nothing to prune or re-accept/);
    expect(readVersionFile(tmpDir)?.baselineReconciledBy).toBe(ALIGN_VERSION);
  });
});

describe('align upgrade — consent refused', () => {
  it('non-interactive without --yes leaves the baseline and version stamp byte-identical, and exits non-zero', async () => {
    tmpDir = copyFixture('simple-app-violation');
    seedBaseline(tmpDir, [staleEntry()]);
    writeVersionStamp(tmpDir, '0.1.0');
    const baselineBefore = fs.readFileSync(baselinePath(tmpDir), 'utf8');
    const versionBefore = fs.readFileSync(versionPath(tmpDir), 'utf8');

    const { result: code, logs } = await withCapturedConsole(() => runUpgrade(tmpDir, { nonInteractive: true }));

    expect(code).toBe(1);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(baselineBefore);
    expect(fs.readFileSync(versionPath(tmpDir), 'utf8')).toBe(versionBefore);
    expect(logs.join('\n')).toMatch(/re-run with --yes/);
    expect(logs.join('\n')).toMatch(/Not fully reconciled/);
  });

  it('interactively declining both prompts leaves everything untouched too', async () => {
    tmpDir = copyFixture('simple-app-violation');
    seedBaseline(tmpDir, [staleEntry()]);
    writeVersionStamp(tmpDir, '0.1.0'); // writeBaseline above already stamped alignVersion=current; override it back
    const baselineBefore = fs.readFileSync(baselinePath(tmpDir), 'utf8');
    const versionBefore = fs.readFileSync(versionPath(tmpDir), 'utf8');

    const { result: code } = await withCapturedConsole(() =>
      runUpgrade(tmpDir, { nonInteractive: false, confirm: alwaysNo }),
    );

    expect(code).toBe(1);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(baselineBefore);
    expect(fs.readFileSync(versionPath(tmpDir), 'utf8')).toBe(versionBefore); // byte-identical — never re-stamped
  });
});

describe('align upgrade — partial consent', () => {
  it('consenting to prune but not accept mutates the baseline but does NOT advance baselineReconciledBy', async () => {
    tmpDir = copyFixture('simple-app-violation');
    seedBaseline(tmpDir, [staleEntry()]);
    writeVersionStamp(tmpDir, '0.1.0', '0.1.0'); // both fields start at an older version

    const pruneOnly = async (question: string): Promise<boolean> => question.includes('Prune');
    const { result: code, logs } = await withCapturedConsole(() =>
      runUpgrade(tmpDir, { nonInteractive: false, confirm: pruneOnly }),
    );

    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(/Not fully reconciled/);

    // Prune happened: the stale entry is gone, and the real violation was never accepted.
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(0);
    expect(await runCheck(tmpDir, { json: false })).toBe(1); // still red — never accepted

    // alignVersion advanced (writeBaseline's own choke point, `stampAlignVersion`) but
    // baselineReconciledBy — the field THIS test is about — stayed at its old value.
    const stamp = readVersionFile(tmpDir);
    expect(stamp?.alignVersion).toBe(ALIGN_VERSION);
    expect(stamp?.baselineReconciledBy).toBe('0.1.0');
  });

  it('consenting to accept but not prune leaves the stale entry in place and also does not stamp', async () => {
    tmpDir = copyFixture('simple-app-violation');
    seedBaseline(tmpDir, [staleEntry()]);
    writeVersionStamp(tmpDir, '0.1.0', '0.1.0'); // both fields start at an older version

    const acceptOnly = async (question: string): Promise<boolean> => question.includes('Re-accept');
    const { result: code } = await withCapturedConsole(() =>
      runUpgrade(tmpDir, { nonInteractive: false, confirm: acceptOnly }),
    );

    expect(code).toBe(1);
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(2); // stale entry still present, PLUS the newly-accepted real violation
    expect(after.some((e) => e.fingerprint === toViolationId('stale-orphaned-entry'))).toBe(true);

    const stamp = readVersionFile(tmpDir);
    expect(stamp?.baselineReconciledBy).toBe('0.1.0'); // unchanged
  });
});

describe('align upgrade — --notes', () => {
  it('prints notes and validator findings, and mutates/stamps nothing', async () => {
    tmpDir = copyFixture('simple-app-violation');
    seedBaseline(tmpDir, [staleEntry()]);
    writeVersionStamp(tmpDir, '0.1.0'); // writeBaseline above already stamped alignVersion=current; override it back
    const baselineBefore = fs.readFileSync(baselinePath(tmpDir), 'utf8');
    const versionBefore = fs.readFileSync(versionPath(tmpDir), 'utf8');

    const { result: code, logs } = await withCapturedConsole(() => runUpgrade(tmpDir, { notes: true, nonInteractive: true }));

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Why violation fingerprints changed/);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(baselineBefore);
    expect(fs.readFileSync(versionPath(tmpDir), 'utf8')).toBe(versionBefore); // byte-identical — --notes never writes
  });

  it('--notes with --from reports the requested range, not the detected one', async () => {
    tmpDir = copyFixture('simple-app');

    const { result: code, logs } = await withCapturedConsole(() =>
      runUpgrade(tmpDir, { notes: true, nonInteractive: true, from: '0.0.1' }),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain(`align upgrade: 0.0.1 → ${ALIGN_VERSION}`);
  });
});

describe('align upgrade — errored scan (ADR 023 tier 1)', () => {
  it('refuses outright, stamps nothing, and leaves the baseline byte-identical', async () => {
    tmpDir = copyErroredFixture();
    seedBaseline(tmpDir, [staleEntry()]);
    writeVersionStamp(tmpDir, '0.1.0');
    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');

    const { result: code, errors, logs } = await withCapturedConsole(() => runUpgrade(tmpDir, { nonInteractive: true, yes: true }));

    expect(code).not.toBe(0);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(before);
    expect(readVersionFile(tmpDir)).toEqual({ alignVersion: '0.1.0' });
    expect(errors.join('\n')).toMatch(/refusing to reconcile the baseline/);
    expect(logs.join('\n')).not.toMatch(/Reconciled/);
  });
});

describe('align upgrade — incomplete scan (ADR 023 tier 2)', () => {
  it('refuses to delete without --allow-incomplete, but still re-accepts (adds proceed)', async () => {
    tmpDir = copyIncompleteFixture();
    seedBaseline(tmpDir, [staleEntry()]);
    writeVersionStamp(tmpDir, '0.1.0'); // writeBaseline above already stamped alignVersion=current; override it back

    const { result: code, errors } = await withCapturedConsole(() => runUpgrade(tmpDir, { nonInteractive: true, yes: true }));

    expect(code).toBe(1); // not fully reconciled — prune was blocked
    expect(errors.join('\n')).toMatch(/refusing to delete/);
    expect(errors.join('\n')).toMatch(/--allow-incomplete/);

    // Adds proceed: the real violation WAS accepted even though prune was blocked.
    const after = readBaseline(tmpDir);
    expect(after.some((e) => e.fingerprint === toViolationId('stale-orphaned-entry'))).toBe(true); // still there — not pruned
    expect(after).toHaveLength(2);
    expect(readVersionFile(tmpDir)?.baselineReconciledBy).toBeUndefined(); // not fully reconciled
  });

  it('proceeds with deletion under --allow-incomplete, fully reconciling and stamping', async () => {
    tmpDir = copyIncompleteFixture();
    seedBaseline(tmpDir, [staleEntry()]);
    writeVersionStamp(tmpDir, '0.1.0'); // writeBaseline above already stamped alignVersion=current; override it back

    const code = await runUpgrade(tmpDir, { nonInteractive: true, yes: true, allowIncomplete: true });

    expect(code).toBe(0);
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1); // stale pruned, real violation accepted
    expect(after.some((e) => e.fingerprint === toViolationId('stale-orphaned-entry'))).toBe(false);
    expect(readVersionFile(tmpDir)?.baselineReconciledBy).toBe(ALIGN_VERSION);
  });
});

describe('align upgrade — edge cases', () => {
  it('already current: a clear no-op message, exit 0, no mutation', async () => {
    tmpDir = copyFixture('simple-app-violation');
    seedBaseline(tmpDir, [staleEntry()]);
    writeVersionStamp(tmpDir, ALIGN_VERSION, ALIGN_VERSION);
    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');

    const { result: code, logs } = await withCapturedConsole(() => runUpgrade(tmpDir, { nonInteractive: true, yes: true }));

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Already at the current version/);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(before);
  });

  it('no version.json at all: reports "unknown → current" and still proceeds', async () => {
    tmpDir = copyFixture('simple-app-violation');
    writeBaselineRaw(tmpDir, [staleEntry()]);
    expect(fs.existsSync(versionPath(tmpDir))).toBe(false);

    const { result: code, logs } = await withCapturedConsole(() => runUpgrade(tmpDir, { nonInteractive: true, yes: true }));

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain(`align upgrade: unknown → ${ALIGN_VERSION}`);
  });

  it('--from newer than the running binary refuses as a downgrade, not a silent no-op', async () => {
    tmpDir = copyFixture('simple-app');

    const { result: code, errors, logs } = await withCapturedConsole(() =>
      runUpgrade(tmpDir, { nonInteractive: true, yes: true, from: '9.9.9' }),
    );

    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/downgrade/);
    // Must not read like the "already current" no-op — a distinct message.
    expect(logs.join('\n')).not.toMatch(/Already at the current version/);
  });

  it('a repo with no baseline at all: nothing to reconcile, and no baseline.json is created', async () => {
    tmpDir = copyFixture('simple-app-violation'); // real violation exists, but was never baselined
    expect(fs.existsSync(baselinePath(tmpDir))).toBe(false);

    const { result: code, logs } = await withCapturedConsole(() => runUpgrade(tmpDir, { nonInteractive: true, yes: true }));

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/No baseline exists — nothing to reconcile/);
    expect(fs.existsSync(baselinePath(tmpDir))).toBe(false);
    expect(fs.existsSync(versionPath(tmpDir))).toBe(false);
  });

  it('--from overrides a present stamp for range/transition purposes', async () => {
    tmpDir = copyFixture('simple-app');
    writeVersionStamp(tmpDir, ALIGN_VERSION); // the real stamp says "current"

    const { result: code, logs } = await withCapturedConsole(() =>
      runUpgrade(tmpDir, { notes: true, nonInteractive: true, from: '0.0.1' }),
    );

    // Without --from this would have hit the "already current" branch; the override takes priority.
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain(`align upgrade: 0.0.1 → ${ALIGN_VERSION}`);
    expect(logs.join('\n')).not.toMatch(/Already at the current version/);
  });
});

// `runUpgrade`'s own initial scan must persist a pure move-transfer unconditionally, the same way
// a plain `align check` does (`persistMovedBaseline`, reused directly from `commands/check.ts`) —
// otherwise a rename detected only during THIS scan would be silently lost if nothing else in the
// run turns out to be actionable (see `upgrade.ts`'s own doc comment on why this is called before
// even the tier-1 refusal).
describe('align upgrade — move-transfer (ADR 006, reused from `align check`)', () => {
  it('a pure rename transfers the baseline entry unconditionally, with nothing to consent to', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    const real = readBaseline(tmpDir);
    expect(real).toHaveLength(1);
    writeVersionStamp(tmpDir, '0.1.0');

    // Rename the violating file — same rule, same snippet, so `store.prune`'s content-fingerprint
    // match recognizes this as a MOVE, not a deletion (mirrors
    // `errored-run-mutations.test.ts`'s identical construction for `baseline prune`).
    fs.renameSync(path.join(tmpDir, 'src', 'api', 'service.ts'), path.join(tmpDir, 'src', 'api', 'service-renamed.ts'));

    const { result: code, logs } = await withCapturedConsole(() => runUpgrade(tmpDir, { nonInteractive: true, yes: true }));

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/nothing to prune or re-accept/); // the move already reconciled it — nothing left actionable
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.file).toBe('src/api/service-renamed.ts');
    expect(readVersionFile(tmpDir)?.baselineReconciledBy).toBe(ALIGN_VERSION);
  });
});
