import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readBaseline, writeBaseline } from '../src/align-dir.js';
import { baselineAccept } from '../src/commands/baseline.js';
import { runCheck } from '../src/commands/check.js';
import { runInit } from '../src/commands/init.js';
import { toRuleId, toRepoRelativePath, toViolationId } from '@spikedpunch/align-core';

// ADR 023's 2026-08-11 amendment: tier 2 extends to `align init`, at BOTH write paths, through the
// one guard `partitionAndRefuseIfBaselineWriteAtRisk` (`commands/init.ts`). Split out of
// `errored-run-mutations.test.ts` (this repo's own `arch.metric` 500-line-per-file rule, which that
// file was about to exceed) rather than sharing its helpers — every sibling test file in this
// directory (`baseline-corruption.test.ts`, `errored-run-mutations.test.ts`) already defines its
// own local copies of the same fixture/console-capture helpers instead of importing shared ones,
// so this follows the established per-file pattern rather than introducing a new one.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-init-incomplete-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  linkAlignCore(dest);
  return dest;
}

/**
 * Every fixture's `align.config.ts` imports `@spikedpunch/align-core/dsl`. In a real repo that
 * resolves via a normal devDependency install; a fixture copied to a bare tmpdir has no
 * `node_modules` at all, so the SCANNER reports `align.config.ts`'s own import as an unresolvable
 * external specifier: a `missing-dependencies` advisory (`complete: false`) that is purely a
 * test-harness artifact, never present for a real, properly-installed repo. Symlinking the real
 * built core package in mirrors a real install and keeps these fixtures' scans `complete: true`
 * by default — `simple-app-violation-incomplete` (below) adds its OWN, deliberate unresolvable
 * import on top of this, which is the real signal under test. See
 * `errored-run-mutations.test.ts`'s identical helper for the fuller reasoning.
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
 * ERRORED architecture gate (tier 1). Mirrors `errored-run-mutations.test.ts`'s
 * `copyErroredFixture` — needed here too, to pin that `--allow-incomplete` never rescues tier 1.
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
 * This run evaluates every rule normally; only the completeness axis differs — exactly the
 * precondition `align init`'s SEED write path needs.
 */
function copyIncompleteFixture(): string {
  return copyFixture('simple-app-violation-incomplete');
}

/**
 * `simple-app-violation-incomplete` with its `api cannotDependOn ui` rule stripped to an empty
 * ruleset — components only, no rules — so a fresh scan is GREEN (zero violations) while remaining
 * `complete: false`: the fixture's own unresolvable import (`ui/component.ts`) fires the
 * missing-dependencies advisory independent of what rules are declared, since the advisory comes
 * from the scanner building the dependency graph, not from rule evaluation. This is `align init`'s
 * ZERO-VIOLATIONS write path's precondition — a green-but-incomplete scan, the exact shape the ADR
 * 023 amendment's own reproduction used (docs/adr/023-2026-08-08-incomplete-scan-refusal.md, "Zero-violations
 * path"). Config is rewritten before the first `import()` — a dynamic `import()` of the same
 * absolute path is module-cached in-process, so a config rewritten mid-test would silently keep
 * serving the old ruleset.
 */
function copyIncompleteGreenFixture(): string {
  const dest = copyFixture('simple-app-violation-incomplete');
  fs.writeFileSync(
    path.join(dest, 'align.config.ts'),
    `import { defineProject } from '@spikedpunch/align-core/dsl';\n\n` +
      `export default defineProject({\n` +
      `  components: { api: 'src/api/**', ui: 'src/ui/**' },\n` +
      `  rules: () => [],\n` +
      `});\n`,
    'utf8',
  );
  return dest;
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

// The one guard `partitionAndRefuseIfBaselineWriteAtRisk` (`commands/init.ts`) both of `init`'s write paths
// route through. Mirrors `errored-run-mutations.test.ts`'s `align baseline prune` tier-2 describe
// block exactly — same at-risk/allow-incomplete/boundary shape — for the two write paths the
// amendment names: the zero-violations reset (the branch that persists `[]`) and the seed path
// (`--accept-existing`, the branch that persists only the CURRENT scan's violations).
describe('`align init` on an incomplete (complete: false) run — ADR 023 tier 2 amendment (2026-08-11)', () => {
  it('zero-violations path refuses on a green-but-incomplete scan with an existing baseline, names the at-risk count and --allow-incomplete, and leaves the baseline byte-for-byte unchanged', async () => {
    tmpDir = copyIncompleteGreenFixture();
    writeBaseline(tmpDir, [
      {
        fingerprint: toViolationId('stale-1'),
        ruleId: toRuleId('arch.no-dependency:api->ui'),
        file: toRepoRelativePath('src/api/service.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);

    // Precondition: the fresh scan really is green (no rules) AND incomplete (the unresolvable
    // import still fires the advisory regardless of the ruleset) — the exact combination that used
    // to make `init` print "Initial check is green" and wipe the baseline.
    const { result: checkCode, logs: checkLogs } = await withCapturedConsole(() => runCheck(tmpDir, { json: false }));
    expect(checkCode).toBe(0);
    expect(checkLogs.join('\n')).toMatch(/verdict: green/);
    expect(checkLogs.join('\n')).toMatch(/missing-dependencies/);

    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');
    const { result: code, errors, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: false, nonInteractive: true, noScripts: true }),
    );

    expect(code).not.toBe(0);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(before);
    expect(logs.join('\n')).not.toMatch(/Initial check is green/);
    expect(errors.join('\n')).toContain('align init');
    expect(errors.join('\n')).toMatch(/refusing to delete 1 entry/);
    expect(errors.join('\n')).toMatch(/--allow-incomplete/);
  });

  it('seed path refuses when a pre-seeded entry is no longer observed on an incomplete scan, and leaves the baseline byte-for-byte unchanged', async () => {
    tmpDir = copyIncompleteFixture();
    writeBaseline(tmpDir, [
      {
        fingerprint: toViolationId('stale-1'),
        ruleId: toRuleId('arch.no-dependency:api->ui'),
        file: toRepoRelativePath('src/api/service.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);

    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');
    const { result: code, errors, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: true, nonInteractive: true, noScripts: true }),
    );

    expect(code).not.toBe(0);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(before);
    expect(logs.join('\n')).not.toMatch(/Seeded baseline/);
    expect(errors.join('\n')).toContain('align init');
    expect(errors.join('\n')).toMatch(/refusing to delete 1 entry/);
    expect(errors.join('\n')).toMatch(/--allow-incomplete/);
  });

  it('zero-violations path proceeds under --allow-incomplete, producing the same result as today', async () => {
    tmpDir = copyIncompleteGreenFixture();
    writeBaseline(tmpDir, [
      {
        fingerprint: toViolationId('stale-1'),
        ruleId: toRuleId('arch.no-dependency:api->ui'),
        file: toRepoRelativePath('src/api/service.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);

    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: false, nonInteractive: true, noScripts: true, allowIncomplete: true }),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Initial check is green/);
    expect(readBaseline(tmpDir)).toHaveLength(0);
  });

  it('seed path proceeds under --allow-incomplete, producing the same result as today', async () => {
    tmpDir = copyIncompleteFixture();
    writeBaseline(tmpDir, [
      {
        fingerprint: toViolationId('stale-1'),
        ruleId: toRuleId('arch.no-dependency:api->ui'),
        file: toRepoRelativePath('src/api/service.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);

    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: true, nonInteractive: true, noScripts: true, allowIncomplete: true }),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Seeded baseline with 1 pre-existing violation/);
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.acceptedBy).toBe('accept-existing');
  });

  it('zero-violations path is unaffected on a COMPLETE scan — pins the boundary explicitly', async () => {
    tmpDir = copyFixture('simple-app');
    writeBaseline(tmpDir, [
      {
        fingerprint: toViolationId('stale-1'),
        ruleId: toRuleId('arch.no-cycles'),
        file: toRepoRelativePath('src/a.ts'),
        acceptedAt: 1,
        acceptedBy: 'manual',
      },
    ]);

    const { logs: checkLogs } = await withCapturedConsole(() => runCheck(tmpDir, { json: false }));
    expect(checkLogs.join('\n')).not.toMatch(/missing-dependencies/);

    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: false, nonInteractive: true, noScripts: true }),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Initial check is green/);
    expect(readBaseline(tmpDir)).toHaveLength(0);
  });

  it('seed path is unaffected on a COMPLETE scan — dropping an unobserved entry there is correct prune semantics, not a defect', async () => {
    tmpDir = copyFixture('simple-app-violation');
    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    const real = readBaseline(tmpDir);
    expect(real).toHaveLength(1);
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

    const { logs: checkLogs } = await withCapturedConsole(() => runCheck(tmpDir, { json: false }));
    expect(checkLogs.join('\n')).not.toMatch(/missing-dependencies/);

    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: true, nonInteractive: true, noScripts: true }),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Seeded baseline with 1 pre-existing violation/);
    const after = readBaseline(tmpDir);
    expect(after).toHaveLength(1);
    expect(after[0]?.fingerprint).not.toBe(toViolationId('stale-1'));
  });

  it('atRiskCount 0 is never refused on a first init with no existing baseline, even on an incomplete scan', async () => {
    tmpDir = copyIncompleteFixture();
    expect(readBaseline(tmpDir)).toHaveLength(0);

    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: true, nonInteractive: true, noScripts: true }),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Seeded baseline with 1 pre-existing violation/);
    expect(readBaseline(tmpDir)).toHaveLength(1);
  });

  it('atRiskCount 0 is never refused on the seed path when every existing entry is still observed, even on an incomplete scan', async () => {
    tmpDir = copyIncompleteFixture();
    await withCapturedConsole(() => baselineAccept(tmpDir, undefined));
    const real = readBaseline(tmpDir);
    expect(real).toHaveLength(1);

    const { result: code, logs } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: true, nonInteractive: true, noScripts: true }),
    );

    expect(code).toBe(0);
    expect(logs.join('\n')).toMatch(/Seeded baseline with 1 pre-existing violation/);
    expect(readBaseline(tmpDir)).toHaveLength(1);
  });

  it('refuses on a corrupt .align/baseline.json, exits non-zero, and leaves the corrupt bytes untouched', async () => {
    tmpDir = copyFixture('simple-app');
    const corrupt = '{ this is not valid json at all';
    fs.mkdirSync(path.join(tmpDir, '.align'), { recursive: true });
    fs.writeFileSync(baselinePath(tmpDir), corrupt, 'utf8');

    const { result: code, errors } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: false, nonInteractive: true, noScripts: true }),
    );

    expect(code).not.toBe(0);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(corrupt);
    expect(errors.join('\n')).toContain('align init');
    expect(errors.join('\n')).toMatch(/repair or delete the file/i);
  });

  it('does NOT rescue an errored run — `--allow-incomplete` has no effect on tier 1', async () => {
    tmpDir = copyErroredFixture();
    const before = fs.readFileSync(baselinePath(tmpDir), 'utf8');

    const { result: code, errors } = await withCapturedConsole(() =>
      runInit(tmpDir, { acceptExisting: false, nonInteractive: true, noScripts: true, allowIncomplete: true }),
    );

    expect(code).not.toBe(0);
    expect(fs.readFileSync(baselinePath(tmpDir), 'utf8')).toBe(before);
    expect(errors.join('\n')).toMatch(/did not complete/);
  });
});
