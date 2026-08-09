import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readBaseline, writeBaseline } from '../src/align-dir.js';
import { baselineAccept, baselinePrune } from '../src/commands/baseline.js';
import { runCheck } from '../src/commands/check.js';
import { runInit } from '../src/commands/init.js';
import { refuseIfRunIncomplete } from '../src/errored-run.js';
import { toRuleId, toRepoRelativePath, toViolationId, type CheckRun } from '@spikedpunch/align-core';

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
  linkAlignCore(dest);
  return dest;
}

/**
 * Every fixture's `align.config.ts` imports `@spikedpunch/align-core/dsl`. In a real repo that
 * resolves via a normal devDependency install; a fixture copied to a bare tmpdir has no
 * `node_modules` at all, so the SCANNER (which walks and resolves imports across the whole repo,
 * not just `loadConfig`'s own dynamic `import()` — `plugin-typescript/src/scanner.ts`) reports
 * `align.config.ts`'s own import as an unresolvable external specifier: a `missing-dependencies`
 * advisory (`complete: false`) that is purely a test-harness artifact, never present for a real,
 * properly-installed repo (verified: `align check` on this monorepo itself reports no such
 * advisory). ADR 023 tier 2 (`baselinePrune`'s `refuseIfRunIncomplete`, below) is the first
 * consumer that actually acts on `complete`, which is what surfaced this — symlinking the real
 * built core package in mirrors a real install and keeps these fixtures' scans `complete: true`,
 * matching production. `simple-app-violation-incomplete` (below) adds its OWN, deliberate
 * unresolvable import on top of this — that one is the real signal under test, not an artifact.
 */
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

/**
 * ADR 023's second axis: `simple-app-violation-incomplete` is `simple-app-violation` (the real
 * `api` cannotDependOn `ui` rule, genuinely violated) plus one extra import in `ui/component.ts` of
 * a package that is never installed in the fixture — its specifier resolves to `unresolved`, which
 * surfaces as a `missing-dependencies` advisory (`complete: false`), WITHOUT erroring any gate.
 * Unlike `copyErroredFixture`, this run evaluates every rule normally; only the completeness axis
 * differs.
 */
function copyIncompleteFixture(): string {
  return copyFixture('simple-app-violation-incomplete');
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

describe('`refuseIfRunIncomplete` (ADR 023 tier 2, unit-level)', () => {
  function runWith(complete: boolean): CheckRun {
    return {
      verdict: 'red',
      gates: [],
      advisories: complete ? [] : [{ kind: 'missing-dependencies', message: 'deps missing' }],
      scannedAt: Date.now(),
      ungroundedComponents: [],
    };
  }

  it('refuses when the scan is incomplete, something is actually at risk, and there is no override', () => {
    const code = refuseIfRunIncomplete('align baseline prune', runWith(false), 3, false);
    expect(code).toBe(1);
  });

  it('proceeds (returns undefined) when --allow-incomplete overrides an incomplete scan', () => {
    expect(refuseIfRunIncomplete('align baseline prune', runWith(false), 3, true)).toBeUndefined();
  });

  it('proceeds when the scan is complete, regardless of the override flag', () => {
    expect(refuseIfRunIncomplete('align baseline prune', runWith(true), 3, false)).toBeUndefined();
  });

  it('never refuses when nothing is actually at risk of deletion (atRiskCount 0) — a pure transfer is never blocked', () => {
    expect(refuseIfRunIncomplete('align baseline prune', runWith(false), 0, false)).toBeUndefined();
  });
});

describe('`align baseline prune` on an incomplete (complete: false) run — ADR 023 tier 2', () => {
  it('refuses to delete, exits non-zero, names the exact count at risk, and leaves the baseline byte-for-byte unchanged', async () => {
    tmpDir = copyIncompleteFixture();

    // Precondition, checked BEFORE anything is baselined (accepting the real violation below would
    // make a same-baseline `runCheck` report green, since the fingerprint would then be tolerated —
    // that's not what's under test here): the fresh scan really is red (the real violation fires)
    // AND incomplete (the unresolvable import fired a missing-dependencies advisory) — the exact
    // combination ADR 023 says `refuseIfRunErrored` alone lets straight through.
    const { result: checkCode, logs: checkLogs } = await withCapturedConsole(() => runCheck(tmpDir, { json: false }));
    expect(checkCode).toBe(1);
    expect(checkLogs.join('\n')).toMatch(/verdict: red/);
    expect(checkLogs.join('\n')).toMatch(/missing-dependencies/);

    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    const real = readBaseline(tmpDir);
    expect(real).toHaveLength(1); // the genuine api->ui violation, correctly baselined

    // Two stale entries whose files are still present in the scan (FRAGILE #7's "fixed, not
    // moved" case) — exactly the shape `store.prune` would otherwise delete.
    writeBaseline(tmpDir, [
      ...real,
      {
        fingerprint: toViolationId('stale-1'),
        ruleId: toRuleId('arch.no-dependency:api->ui'),
        file: toRepoRelativePath('src/api/service.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
      {
        fingerprint: toViolationId('stale-2'),
        ruleId: toRuleId('arch.no-dependency:api->ui'),
        file: toRepoRelativePath('src/ui/component.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);

    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');
    const { result: code, errors, logs } = await withCapturedConsole(() => baselinePrune(tmpDir));

    expect(code).not.toBe(0);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(before);
    expect(logs.join('\n')).not.toMatch(/Pruned/);
    expect(errors.join('\n')).toContain('align baseline prune');
    expect(errors.join('\n')).toMatch(/refusing to delete 2 entries/);
    expect(errors.join('\n')).toMatch(/missing-dependencies/);
    expect(errors.join('\n')).toMatch(/--allow-incomplete/);
  });

  it('proceeds under --allow-incomplete, deleting exactly the entries actually at risk', async () => {
    tmpDir = copyIncompleteFixture();
    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    const real = readBaseline(tmpDir);
    writeBaseline(tmpDir, [
      ...real,
      {
        fingerprint: toViolationId('stale-1'),
        ruleId: toRuleId('arch.no-dependency:api->ui'),
        file: toRepoRelativePath('src/api/service.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);

    const { result: code, logs } = await withCapturedConsole(() => baselinePrune(tmpDir, true));
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Pruned 1 fixed violation/);
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.fingerprint).toBe(real[0]?.fingerprint);
  });

  it('is unaffected on a COMPLETE scan (no missing-dependencies advisory) — the existing green/red prune tests above cover this; this pins the boundary explicitly', async () => {
    tmpDir = copyFixture('simple-app-violation');
    // Precondition, checked before baselining (see the note in the test above).
    const { result: checkCode, logs: checkLogs } = await withCapturedConsole(() => runCheck(tmpDir, { json: false }));
    expect(checkCode).toBe(1);
    expect(checkLogs.join('\n')).not.toMatch(/missing-dependencies/);

    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));

    // Passing allowIncomplete: true on a complete scan is a no-op — nothing to override.
    const { result: code, logs } = await withCapturedConsole(() => baselinePrune(tmpDir, true));
    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Pruned 0 fixed violation/);
  });

  it('never refuses a pure move-transfer on an incomplete scan — nothing is actually at risk of deletion', async () => {
    tmpDir = copyIncompleteFixture();
    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    const real = readBaseline(tmpDir);
    expect(real).toHaveLength(1);

    // Rename the violating file — same rule, same snippet, so `store.prune`'s content-fingerprint
    // match (FRAGILE #7) recognizes this as a MOVE, not a deletion, even though the scan is
    // complete: false.
    fs.renameSync(path.join(tmpDir, 'src', 'api', 'service.ts'), path.join(tmpDir, 'src', 'api', 'service-renamed.ts'));

    const { result: code, logs } = await withCapturedConsole(() => baselinePrune(tmpDir));
    expect(code).toBe(0); // not blocked — nothing was actually at risk of deletion
    expect(logs.join('\n')).toMatch(/1 entry transferred/);
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.file).toBe('src/api/service-renamed.ts');
  });

  it('`align baseline accept` is unaffected by an incomplete scan — it only ever adds', async () => {
    tmpDir = copyIncompleteFixture();
    const { result: code } = await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    expect(code).toBe(0);
    expect(readBaseline(tmpDir)).toHaveLength(1);
  });

  it('does NOT rescue an errored run — `--allow-incomplete` has no effect on tier 1', async () => {
    tmpDir = copyErroredFixture();
    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');

    const { result: code, errors } = await withCapturedConsole(() => baselinePrune(tmpDir, true));

    expect(code).not.toBe(0);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(before);
    expect(errors.join('\n')).toMatch(/did not complete/);
  });
});
