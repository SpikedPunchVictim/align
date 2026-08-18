import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toRepoRelativePath, toRuleId, toViolationId, type BaselineEntry } from '@spikedpunch/align-core';
import { baselinePrune } from '../src/commands/baseline.js';
import { runInit } from '../src/commands/init.js';
import { readBaseline } from '../src/align-dir.js';
import { seedBaseline } from './seed-baseline.js';

/**
 * ADR 028 Stage 4 — what `align baseline prune` does when it cannot prove a violation was fixed,
 * and what it asks before it deletes anything.
 *
 * Stages 1-2 gave retention two mechanisms: a recorded blind spot covering the file, or the file
 * still being on disk. Both are per-FILE, and both answer "nothing explains this absence" for a file
 * whose entire directory is gone — so a partial checkout deleted the missing tree's consent records
 * and exited 0. That was reproduced by two independent reviewers on 2026-08-17 and is the
 * severity-zero class (CLAUDE.md rule 6). Mechanism 3 is the fix, and the first describe below is
 * its regression pin.
 *
 * A whole-run refusal (a "floor" keyed on every component matching zero files) was tried first and
 * removed the same day: it was a per-run guard against per-entry damage, so it missed the very
 * partial checkout it was written for, and its non-overridable refusal trapped legitimate
 * repositories — a manifest-only greenfield repo could neither prune nor re-run `init`. Mechanism 3
 * replaces it at the granularity the damage actually has. Nothing here should be read as the floor
 * having been weakened; it was replaced by something that fires where it did not.
 *
 * The consent gate (ADR 006) is the other half. Mechanism 3 is deliberately conservative, and the
 * commonest way baselined debt is paid down is deleting dead code — which mechanism 3 cannot
 * distinguish from a missing tree. Rather than make that path cost a second command, every deletion
 * now asks. A run that deletes nothing is never gated.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string | undefined;

/** Mirrors `errored-run-mutations.test.ts`'s helper of the same name: a fixture copied to a bare
 * tmpdir has no `node_modules`, so the scanner reports `align.config.ts`'s own dsl import as an
 * unresolved external specifier — a `missing-dependencies` advisory that is a harness artifact, not
 * a signal. Symlinking the real core package mirrors a normal install and keeps these scans
 * `complete: true`. */
function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

function copyFixture(name: string): string {
  const dest = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'align-prune-floor-test-')));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  linkAlignCore(dest);
  return dest;
}

/**
 * Rewrites the fixture's config BEFORE the first `loadConfig` of the test — a dynamic `import()` of
 * the same absolute path is module-cached in-process, so a config rewritten mid-test would silently
 * keep serving the old ruleset (the same discipline `copyErroredFixture` documents).
 */
function writeConfig(dir: string, components: string, extra = ''): void {
  fs.writeFileSync(
    path.join(dir, 'align.config.ts'),
    `import { defineProject } from '@spikedpunch/align-core/dsl';\n\n` +
      `export default defineProject({\n` +
      `  components: ${components},\n` +
      `  rules: (c) => [c.arch.noCycles()],\n` +
      `});\n` +
      extra,
    'utf8',
  );
}

function entry(file: string, fingerprint: string): BaselineEntry {
  return {
    fingerprint: toViolationId(fingerprint),
    ruleId: toRuleId('arch.no-cycles'),
    file: toRepoRelativePath(file),
    acceptedAt: 1234,
    acceptedBy: 'manual',
  };
}

async function withCapturedConsole<T>(run: () => Promise<T>): Promise<{ readonly result: T; readonly logs: string; readonly errors: string }> {
  const logLines: string[] = [];
  const errLines: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logLines.push(args.map(String).join(' ')));
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errLines.push(args.map(String).join(' ')));
  try {
    const result = await run();
    return { result, logs: logLines.join('\n'), errors: errLines.join('\n') };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

function baselineBytes(dir: string): string {
  return fs.readFileSync(path.join(dir, '.align', 'baseline.json'), 'utf8');
}

/**
 * A repo whose scan grounds NOTHING: every source file is excluded, so the only declared component
 * matches zero files, and it carries a non-`fail` empty policy so `validateClassifiedComponents`
 * never errors — which is the configuration `align init` itself generates for a zero-file component
 * (`commands/init.ts`), so this is the reachable shape, not a contrived one. Tier 1 therefore does
 * not fire and the run reaches the destructive path with nothing to reason from.
 */
function buildBlindRepo(emptyPolicy: 'allow' | 'until-populated'): string {
  const dir = copyFixture('simple-app-violation');
  writeConfig(dir, `{ app: { pattern: 'src/**', empty: '${emptyPolicy}' } }`, `\nexport const excludes = ['src/**'];\n`);
  return dir;
}

/**
 * A repo whose scan is healthy (it observes `src/**`) but narrower than the repository: `vendor/` is
 * excluded, so an entry under it is RETAINED by Stage 1's blind-spot record rather than pruned. This
 * is the state the escape hatch exists for — retention that is correct and permanent.
 */
function buildPartiallyBlindRepo(): string {
  const dir = copyFixture('simple-app-violation');
  fs.mkdirSync(path.join(dir, 'vendor', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vendor', 'lib.ts'), 'export const v = 1;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'vendor', 'nested', 'deep.ts'), 'export const d = 1;\n', 'utf8');
  writeConfig(dir, `{ app: 'src/**' }`, `\nexport const excludes = ['vendor/**'];\n`);
  return dir;
}

afterEach(() => {
  if (tmpDir !== undefined) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});


/** Two components, a real cycle between them, both `until-populated` — the policy `align init`
 * writes onto a zero-file component and onto every component under `--greenfield`. Deleting one
 * component's directory is a partial checkout in miniature. */
function buildTwoComponentRepo(): string {
  const dir = copyFixture('simple-app-violation');
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'one.ts'), 'import { fromB } from "../b/one.js";\nexport const a = () => fromB();\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b', 'one.ts'), 'import { a } from "../a/one.js";\nexport const fromB = () => typeof a;\n', 'utf8');
  fs.rmSync(path.join(dir, 'src'), { recursive: true, force: true });
  writeConfig(
    dir,
    `{ a: { pattern: 'a/**', empty: 'until-populated' }, b: { pattern: 'b/**', empty: 'until-populated' } }`,
  );
  return dir;
}

describe('mechanism 3: a missing DIRECTORY is not evidence that its files were fixed (ADR 028 Stage 4)', () => {
  it('retains the entries of a component whose tree is absent, instead of pruning them at exit 0', async () => {
    // THE REGRESSION PIN. Before 2026-08-17 this exact sequence printed "Pruned 1 fixed
    // violation(s)", exited 0, and left `.align/baseline.json` as `[]`.
    tmpDir = buildTwoComponentRepo();
    await withCapturedConsole(() => baselinePrune(tmpDir!, { yes: true })); // seed nothing; accept below
    seedBaseline(tmpDir, [entry('b/one.ts', 'e1')]);
    const before = baselineBytes(tmpDir);
    fs.rmSync(path.join(tmpDir, 'b'), { recursive: true, force: true });

    const { result: code, logs } = await withCapturedConsole(() => baselinePrune(tmpDir!, { yes: true }));

    expect(code).toBe(0);
    expect(readBaseline(tmpDir).map((e) => e.file)).toEqual(['b/one.ts']);
    expect(logs).toMatch(/Retained 1 entry/);
    // The reason is printed, never just the count (ADR 028 §3) — and it names the directory, which
    // is the fact that distinguishes this from the per-file mechanisms.
    expect(logs).toMatch(/b \(that whole directory is absent from this working tree/);
    // The remedy is named in the same line — a retention the user cannot act on is a dead end.
    expect(logs).toMatch(/--forget-unscanned b/);
    expect(baselineBytes(tmpDir)).toBe(before);
  });

  it('still prunes a file deleted from a directory the scan DID observe — the boundary that keeps prune useful', async () => {
    // The other half of the trade. If this ever starts retaining, mechanism 3 has stopped being a
    // missing-tree test and become "never delete anything", and `prune` is a no-op command.
    tmpDir = buildTwoComponentRepo();
    seedBaseline(tmpDir, [entry('b/deleted-sibling.ts', 'e1')]); // b/one.ts is still there and observed

    const { result: code, logs } = await withCapturedConsole(() => baselinePrune(tmpDir!, { yes: true }));

    expect(code).toBe(0);
    expect(logs).toMatch(/Pruned 1 fixed violation/);
    expect(readBaseline(tmpDir)).toEqual([]);
  });

  it('never retains a ROOT-level entry while the scan observed anything — the greenfield block, pinned', async () => {
    // A manifest-domain entry (`package.json`) has `''` as its directory. If mechanism 3 tested that
    // the way it tests a real directory, every such entry would be retained forever on any repo with
    // no source files — which is exactly the trap the removed floor sprang on a greenfield repo.
    tmpDir = buildTwoComponentRepo();
    seedBaseline(tmpDir, [entry('package.json', 'e1')]);

    const { result: code, logs } = await withCapturedConsole(() => baselinePrune(tmpDir!, { yes: true }));

    expect(code).toBe(0);
    expect(logs).toMatch(/Pruned 1 fixed violation/);
    expect(readBaseline(tmpDir)).toEqual([]);
  });
});

describe('the consent gate — every deletion is approved, and only deletions are gated (ADR 006)', () => {
  it('refuses non-interactively without --yes, leaving the baseline byte-identical', async () => {
    tmpDir = buildTwoComponentRepo();
    seedBaseline(tmpDir, [entry('b/deleted-sibling.ts', 'e1')]);
    const before = baselineBytes(tmpDir);

    const { result: code, errors, logs } = await withCapturedConsole(() => baselinePrune(tmpDir!, { nonInteractive: true }));

    expect(code).not.toBe(0);
    expect(baselineBytes(tmpDir)).toBe(before);
    expect(logs).not.toMatch(/Pruned/);
    expect(errors).toMatch(/silence is never consent/);
  });

  it('deletes when the human says yes', async () => {
    tmpDir = buildTwoComponentRepo();
    seedBaseline(tmpDir, [entry('b/deleted-sibling.ts', 'e1')]);

    const { result: code } = await withCapturedConsole(() => baselinePrune(tmpDir!, { confirm: async () => true }));

    expect(code).toBe(0);
    expect(readBaseline(tmpDir)).toEqual([]);
  });

  it('changes nothing when the human says no', async () => {
    tmpDir = buildTwoComponentRepo();
    seedBaseline(tmpDir, [entry('b/deleted-sibling.ts', 'e1')]);
    const before = baselineBytes(tmpDir);

    const { result: code, logs } = await withCapturedConsole(() => baselinePrune(tmpDir!, { confirm: async () => false }));

    expect(code).not.toBe(0);
    expect(baselineBytes(tmpDir)).toBe(before);
    expect(logs).toMatch(/Not pruning/);
  });

  it('never asks when there is nothing to delete — prune stays safe in a pre-commit hook', async () => {
    // An all-retained run destroys nothing, so gating it would turn a safe read-mostly command into
    // one that fails CI for asking a question nobody can answer.
    tmpDir = buildTwoComponentRepo();
    seedBaseline(tmpDir, [entry('b/one.ts', 'e1')]);
    fs.rmSync(path.join(tmpDir, 'b'), { recursive: true, force: true });
    let asked = false;

    const { result: code } = await withCapturedConsole(() =>
      baselinePrune(tmpDir!, {
        nonInteractive: true,
        confirm: async () => {
          asked = true;
          return true;
        },
      }),
    );

    expect(code).toBe(0);
    expect(asked).toBe(false);
    expect(readBaseline(tmpDir)).toHaveLength(1);
  });
});

describe('align baseline prune --forget-unscanned <prefix> — the way back out of retention', () => {
  it('forfeits retained entries at or under the prefix, and leaves everything else alone', async () => {
    // Opus review 2026-08-17: the previous version of this test ended in `toEqual([])`, an assertion
    // identical whether the hatch is scoped or forfeits the entire baseline. The scoping claim is now
    // carried by a surviving entry that the prefix must NOT reach.
    tmpDir = buildPartiallyBlindRepo();
    fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'assets', 'thing.ts'), 'export const t = 1;\n', 'utf8');
    writeConfig(tmpDir, `{ app: 'src/**' }`, `\nexport const excludes = ['vendor/**', 'assets/**'];\n`);
    seedBaseline(tmpDir, [entry('vendor/lib.ts', 'e1'), entry('vendor/nested/deep.ts', 'e2'), entry('assets/thing.ts', 'e3')]);

    const { result: code, logs } = await withCapturedConsole(() =>
      baselinePrune(tmpDir!, { forgetUnscanned: 'vendor', yes: true }),
    );

    expect(code).toBe(0);
    expect(logs).toMatch(/Forgot 2 retained entries under 'vendor'/);
    expect(readBaseline(tmpDir).map((e) => e.file)).toEqual(['assets/thing.ts']);
  });

  it('matches a single file exactly, not only a directory', async () => {
    tmpDir = buildPartiallyBlindRepo();
    seedBaseline(tmpDir, [entry('vendor/lib.ts', 'e1'), entry('vendor/nested/deep.ts', 'e2')]);

    const { result: code } = await withCapturedConsole(() =>
      baselinePrune(tmpDir!, { forgetUnscanned: 'vendor/lib.ts', yes: true }),
    );

    expect(code).toBe(0);
    expect(readBaseline(tmpDir).map((e) => e.file)).toEqual(['vendor/nested/deep.ts']);
  });

  it('does not treat a prefix as a string prefix — `vendor-extra/` is not under `vendor`', async () => {
    tmpDir = buildPartiallyBlindRepo();
    fs.mkdirSync(path.join(tmpDir, 'vendor-extra'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'vendor-extra', 'x.ts'), 'export const x = 1;\n', 'utf8');
    writeConfig(tmpDir, `{ app: 'src/**' }`, `\nexport const excludes = ['vendor/**', 'vendor-extra/**'];\n`);
    seedBaseline(tmpDir, [entry('vendor-extra/x.ts', 'e1')]);

    const { result: code, logs } = await withCapturedConsole(() =>
      baselinePrune(tmpDir!, { forgetUnscanned: 'vendor', yes: true }),
    );

    expect(code).toBe(0);
    expect(logs).toMatch(/matched no retained entry/);
    expect(readBaseline(tmpDir).map((e) => e.file)).toEqual(['vendor-extra/x.ts']);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['.', 'the repository root'],
    ['./', 'the repository root with a separator'],
    ['/', 'absolute'],
    ['/etc', 'absolute path'],
    ['..', 'escapes the repository'],
    ['../sibling', 'escapes the repository'],
    ['vendor/../..', 'escapes the repository via an interior segment'],
  ])('refuses the prefix %j (%s) — there is no bare form that forgets everything', async (prefix) => {
    tmpDir = buildPartiallyBlindRepo();
    seedBaseline(tmpDir, [entry('vendor/lib.ts', 'e1')]);
    const before = baselineBytes(tmpDir);

    const { result: code, errors } = await withCapturedConsole(() =>
      baselinePrune(tmpDir!, { forgetUnscanned: prefix, yes: true }),
    );

    expect(code).not.toBe(0);
    expect(baselineBytes(tmpDir)).toBe(before);
    expect(errors).toMatch(/--forget-unscanned/);
  });

  it('refuses an errored run before forgetting anything (ADR 023 tier 1, no override)', async () => {
    tmpDir = copyFixture('simple-app-violation');
    writeConfig(tmpDir, `{ app: 'src/**', inner: 'src/api/**' }`, `\nexport const excludes = ['vendor/**'];\n`);
    fs.mkdirSync(path.join(tmpDir, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'vendor', 'lib.ts'), 'export const v = 1;\n', 'utf8');
    seedBaseline(tmpDir, [entry('vendor/lib.ts', 'e1')]);
    const before = baselineBytes(tmpDir);

    const { result: code, errors } = await withCapturedConsole(() =>
      baselinePrune(tmpDir!, { forgetUnscanned: 'vendor', yes: true }),
    );

    expect(code).not.toBe(0);
    expect(baselineBytes(tmpDir)).toBe(before);
    expect(errors).toMatch(/did not complete/);
  });

  it('counts forgotten entries as at-risk for ADR 023 tier 2, and proceeds under --allow-incomplete', async () => {
    tmpDir = copyFixture('simple-app-violation-incomplete');
    fs.mkdirSync(path.join(tmpDir, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'vendor', 'lib.ts'), 'export const v = 1;\n', 'utf8');
    writeConfig(tmpDir, `{ app: 'src/**' }`, `\nexport const excludes = ['vendor/**'];\n`);
    seedBaseline(tmpDir, [entry('vendor/lib.ts', 'e1')]);
    const before = baselineBytes(tmpDir);

    const refused = await withCapturedConsole(() => baselinePrune(tmpDir!, { forgetUnscanned: 'vendor', yes: true }));
    expect(refused.result).not.toBe(0);
    expect(baselineBytes(tmpDir)).toBe(before);
    expect(refused.errors).toMatch(/refusing to delete 1 entry/);

    const allowed = await withCapturedConsole(() =>
      baselinePrune(tmpDir!, { forgetUnscanned: 'vendor', allowIncomplete: true, yes: true }),
    );
    expect(allowed.result).toBe(0);
    expect(readBaseline(tmpDir)).toHaveLength(0);
  });
});

describe("prune's headline never asserts the opposite of what the run did", () => {
  it('says nothing to prune when no entry was even a candidate', async () => {
    tmpDir = buildPartiallyBlindRepo();
    seedBaseline(tmpDir, []);

    const { logs } = await withCapturedConsole(() => baselinePrune(tmpDir!, { yes: true }));

    expect(logs).toMatch(/Nothing to prune/);
    expect(logs).not.toMatch(/Retained/);
  });

  it('says every candidate was retained, and why, when retention saved them all', async () => {
    tmpDir = buildPartiallyBlindRepo();
    seedBaseline(tmpDir, [entry('vendor/lib.ts', 'e1')]);

    const { logs } = await withCapturedConsole(() => baselinePrune(tmpDir!, { yes: true }));

    expect(logs).toMatch(/Pruned 0 .*every candidate was retained/);
    expect(logs).toMatch(/matched the excludes pattern 'vendor\/\*\*'/);
  });

  it('does NOT say "nothing to prune" on a run that forfeited a consent decision', async () => {
    // Both reviewers found this independently on 2026-08-17: the headline was computed from the
    // POST-split retained count, so forfeiting the only retained entry printed "Nothing to prune —
    // no baseline entry is orphaned" directly above "Forgot 1 retained entry ... is deleted".
    tmpDir = buildPartiallyBlindRepo();
    seedBaseline(tmpDir, [entry('vendor/lib.ts', 'e1')]);

    const { logs } = await withCapturedConsole(() =>
      baselinePrune(tmpDir!, { forgetUnscanned: 'vendor', yes: true }),
    );

    expect(logs).not.toMatch(/Nothing to prune/);
    expect(logs).toMatch(/1 retained entry was forfeited on your instruction/);
    expect(readBaseline(tmpDir)).toEqual([]);
  });
});
