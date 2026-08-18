import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { toRepoRelativePath, toRuleId, toViolationId } from '@spikedpunch/align-core';
import { runInit } from '../src/commands/init.js';
import { runCheck } from '../src/commands/check.js';
import { runBuild } from '../src/commands/build.js';
import { runExportIr } from '../src/commands/export-ir.js';
import { baselineAccept, baselinePrune } from '../src/commands/baseline.js';
import { readVersionFile, writeBaseline } from '../src/align-dir.js';
import { ALIGN_VERSION } from '../src/telemetry/index.js';

// ADR 022's write discipline: every command that writes an `.align/` artifact ALSO stamps
// `alignVersion` — EXCEPT a read-only `align check`, which must never create `.align/version.json`
// at all (a check must not mutate the repo it is checking). `baselineReconciledBy` is narrower
// still: only `align init` (and, later, `align upgrade`, out of scope for this slice) may write it
// — not `check`, not `accept`, not `prune`, not `build --apply`, not `export-ir`.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-version-stamp-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  linkAlignCore(dest);
  return dest;
}

/** See `check.test.ts`'s identical helper: fixtures have no real `node_modules`, so the scanner
 * treats align.config.ts's own import as unresolvable without this symlink — a pure test-harness
 * artifact, not a real skew. Every fixture used below gets it so `complete: true` matches
 * production and the fixtures' installed `@spikedpunch/align-core` version matches `ALIGN_VERSION`
 * (they're the same monorepo package, in lockstep), which keeps the pre-existing
 * global-vs-local `version-skew` advisory OUT of these tests' way. */
function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

function versionJsonPath(rootDir: string): string {
  return path.join(rootDir, '.align', 'version.json');
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('align init — stamps both alignVersion and baselineReconciledBy', () => {
  it('a clean repo (green branch, writes an empty baseline) seeds both fields', async () => {
    tmpDir = copyFixture('simple-app');
    fs.rmSync(path.join(tmpDir, 'align.config.ts'));
    const code = await runInit(tmpDir, { acceptExisting: false, nonInteractive: true, noScripts: true });
    expect(code).toBe(0);
    expect(readVersionFile(tmpDir)).toEqual({ alignVersion: ALIGN_VERSION, baselineReconciledBy: ALIGN_VERSION });
  });

  it('a repo with pre-existing violations (seeded branch) also seeds both fields', async () => {
    tmpDir = copyFixture('simple-app-violation');
    fs.rmSync(path.join(tmpDir, 'align.config.ts'));
    const code = await runInit(tmpDir, { acceptExisting: true, nonInteractive: true, noScripts: true });
    expect(code).toBe(0);
    expect(readVersionFile(tmpDir)).toEqual({ alignVersion: ALIGN_VERSION, baselineReconciledBy: ALIGN_VERSION });
  });

  it('re-running init against an already-init\'d repo re-seeds both fields (every init run is a deliberate reconciliation)', async () => {
    tmpDir = copyFixture('simple-app');
    fs.rmSync(path.join(tmpDir, 'align.config.ts'));
    await runInit(tmpDir, { acceptExisting: false, nonInteractive: true, noScripts: true });
    // Pretend an older align wrote the stamp last time.
    fs.writeFileSync(versionJsonPath(tmpDir), JSON.stringify({ alignVersion: '0.0.1', baselineReconciledBy: '0.0.1' }), 'utf8');
    await runInit(tmpDir, { acceptExisting: false, nonInteractive: true, noScripts: true });
    expect(readVersionFile(tmpDir)).toEqual({ alignVersion: ALIGN_VERSION, baselineReconciledBy: ALIGN_VERSION });
  });
});

describe('align baseline accept / prune — stamp alignVersion, never baselineReconciledBy', () => {
  it('`baseline accept` stamps alignVersion and leaves baselineReconciledBy untouched (absent stays absent)', async () => {
    tmpDir = copyFixture('simple-app-violation');
    expect(readVersionFile(tmpDir)).toBeUndefined();
    await baselineAccept(tmpDir, undefined);
    expect(readVersionFile(tmpDir)).toEqual({ alignVersion: ALIGN_VERSION });
  });

  it('`baseline accept` preserves a pre-existing baselineReconciledBy rather than touching it', async () => {
    tmpDir = copyFixture('simple-app-violation');
    fs.mkdirSync(path.join(tmpDir, '.align'), { recursive: true });
    fs.writeFileSync(versionJsonPath(tmpDir), JSON.stringify({ alignVersion: '0.0.1', baselineReconciledBy: '0.0.1' }), 'utf8');
    await baselineAccept(tmpDir, undefined);
    expect(readVersionFile(tmpDir)).toEqual({ alignVersion: ALIGN_VERSION, baselineReconciledBy: '0.0.1' });
  });

  it('`baseline prune` stamps alignVersion and leaves baselineReconciledBy untouched', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await baselineAccept(tmpDir, undefined);
    // Fix the violation on disk so the next prune actually removes an entry.
    fs.writeFileSync(
      path.join(tmpDir, 'src/api/service.ts'),
      `export function handleRequest(): string {\n  return 'ok';\n}\n`,
      'utf8',
    );
    fs.writeFileSync(versionJsonPath(tmpDir), JSON.stringify({ alignVersion: '0.0.1', baselineReconciledBy: '0.0.1' }), 'utf8');
    await baselinePrune(tmpDir, { yes: true });
    expect(readVersionFile(tmpDir)).toEqual({ alignVersion: ALIGN_VERSION, baselineReconciledBy: '0.0.1' });
  });
});

describe('align build --apply — stamps alignVersion, never baselineReconciledBy', () => {
  it('writes generated-rules.json/rules.lock.json and stamps alignVersion only', async () => {
    tmpDir = copyFixture('build-app');
    expect(readVersionFile(tmpDir)).toBeUndefined();
    const code = await runBuild(tmpDir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
    expect(code).toBe(0);
    expect(readVersionFile(tmpDir)).toEqual({ alignVersion: ALIGN_VERSION });
  });
});

describe('align export-ir — stamps alignVersion, never baselineReconciledBy', () => {
  it('writes ruleset-ir.json (default location) and stamps alignVersion only', async () => {
    tmpDir = copyFixture('simple-app');
    expect(readVersionFile(tmpDir)).toBeUndefined();
    const code = await runExportIr(tmpDir);
    expect(code).toBe(0);
    expect(readVersionFile(tmpDir)).toEqual({ alignVersion: ALIGN_VERSION });
  });

  it('does NOT stamp when --out points outside .align/', async () => {
    tmpDir = copyFixture('simple-app');
    const outside = path.join(tmpDir, 'exported-ir.json');
    const code = await runExportIr(tmpDir, { out: outside });
    expect(code).toBe(0);
    expect(fs.existsSync(outside)).toBe(true);
    expect(readVersionFile(tmpDir)).toBeUndefined();
  });
});

describe('align check — the write discipline this slice is most likely to get wrong', () => {
  it('a read-only check on a clean repo does NOT create .align/version.json', async () => {
    tmpDir = copyFixture('simple-app');
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
    expect(fs.existsSync(versionJsonPath(tmpDir))).toBe(false);
    expect(readVersionFile(tmpDir)).toBeUndefined();
  });

  it('a read-only check on a RED repo (violations present, nothing baselined) still does NOT create the file', async () => {
    tmpDir = copyFixture('simple-app-violation');
    expect(await runCheck(tmpDir, { json: false })).toBe(1);
    expect(fs.existsSync(versionJsonPath(tmpDir))).toBe(false);
  });

  it('a move-transfer check DOES stamp alignVersion (the one path a "read-only" check actually writes)', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await baselineAccept(tmpDir, undefined);
    expect(await runCheck(tmpDir, { json: false })).toBe(0);
    // Roll the stamp back to simulate an older align having accepted it, so this test can tell
    // the move-transfer's re-stamp apart from the accept above's own stamp.
    fs.writeFileSync(versionJsonPath(tmpDir), JSON.stringify({ alignVersion: '0.0.1' }), 'utf8');

    fs.renameSync(path.join(tmpDir, 'src/api/service.ts'), path.join(tmpDir, 'src/api/renamed.ts'));
    expect(await runCheck(tmpDir, { json: false })).toBe(0); // move-transfer keeps it green
    expect(readVersionFile(tmpDir)).toEqual({ alignVersion: ALIGN_VERSION });
  });

  it('an errored run stamps nothing — .align/version.json stays absent', async () => {
    tmpDir = copyFixture('simple-app-violation');
    // `api` shadowed by an earlier, broader component under first-match-wins — the same
    // error-inducing config `errored-run-mutations.test.ts` uses to force `verdict: 'error'`.
    fs.writeFileSync(
      path.join(tmpDir, 'align.config.ts'),
      `import { defineProject } from '@spikedpunch/align-core/dsl';\n\n` +
        `export default defineProject({\n` +
        `  components: { outer: 'src/**', api: 'src/api/**', ui: 'src/ui/**' },\n` +
        `  rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],\n` +
        `});\n`,
      'utf8',
    );
    writeBaseline(tmpDir, [
      {
        fingerprint: toViolationId('b26ffb86865fc059'),
        ruleId: toRuleId('arch.no-dependency:api->ui'),
        file: toRepoRelativePath('src/api/service.ts'),
        acceptedAt: 1_700_000_000_000,
        acceptedBy: 'manual',
      },
    ]);
    // The seed write above (writeBaseline) legitimately stamps — reset to absent so this test
    // observes only what the ERRORED check run itself does (nothing).
    fs.rmSync(versionJsonPath(tmpDir), { force: true });

    const code = await runCheck(tmpDir, { json: false });
    expect(code).not.toBe(0);
    expect(fs.existsSync(versionJsonPath(tmpDir))).toBe(false);
  });

  it('an errored `baseline prune` refusal stamps nothing either (mutation guard runs before any write)', async () => {
    tmpDir = copyFixture('simple-app-violation');
    fs.writeFileSync(
      path.join(tmpDir, 'align.config.ts'),
      `import { defineProject } from '@spikedpunch/align-core/dsl';\n\n` +
        `export default defineProject({\n` +
        `  components: { outer: 'src/**', api: 'src/api/**', ui: 'src/ui/**' },\n` +
        `  rules: (c) => [c.arch.layer(c.api).cannotDependOn(c.ui)],\n` +
        `});\n`,
      'utf8',
    );
    writeBaseline(tmpDir, [
      {
        fingerprint: toViolationId('b26ffb86865fc059'),
        ruleId: toRuleId('arch.no-dependency:api->ui'),
        file: toRepoRelativePath('src/api/service.ts'),
        acceptedAt: 1_700_000_000_000,
        acceptedBy: 'manual',
      },
    ]);
    fs.rmSync(versionJsonPath(tmpDir), { force: true });

    const code = await baselinePrune(tmpDir, { yes: true });
    expect(code).not.toBe(0);
    expect(fs.existsSync(versionJsonPath(tmpDir))).toBe(false);
  });
});
