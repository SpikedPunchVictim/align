import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeGitEffects, initTestGitRepo } from '@spikedpunch/align-agent';
import { toRepoRelativePath } from '@spikedpunch/align-core';
import { readVersionFile } from '../src/align-dir.js';
import { runUpgrade } from '../src/commands/upgrade.js';
import { MIGRATION_REGISTRY } from '../src/migrations/registry.js';
import { globDoubleStarSelectorDriftValidator } from '../src/migrations/validators/glob-double-star-drift.js';
import { globDoubleStarSelectorRewriteTransform } from '../src/migrations/transforms/glob-double-star-rewrite.js';
import { ALIGN_VERSION } from '../src/telemetry/process-context.js';

// `align upgrade`'s consent-gated end-to-end drive of the `glob-double-star-selector-rewrite`
// transform (ADR 022, task #16 slice E) — the validator fires, the transform previews the exact
// diff, and consent gates the write, all through the real `runUpgrade` entry point rather than the
// transform's own `preview`/`apply` in isolation (`migration-glob-rewrite-transform.test.ts` covers
// that layer directly).
//
// Real git repos are bootstrapped via `@spikedpunch/align-agent`'s `initTestGitRepo`/
// `createNodeGitEffects` rather than a local `node:child_process` shell-out — see
// `migration-glob-rewrite-transform.test.ts`'s identical note on why (`cli`'s own dogfooded
// `cannotDependOn(external('node:child_process'))` rule, align.config.ts).

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');
let tmpDir: string;

function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

async function copyCommittedFixture(name: string): Promise<string> {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-upgrade-transform-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  linkAlignCore(dest);
  await initTestGitRepo(dest);
  return dest;
}

function configPath(rootDir: string): string {
  return path.join(rootDir, 'align.config.ts');
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

describe('MIGRATION_REGISTRY — the transform is paired with its validator', () => {
  it('the current entry carries a TransformWithValidator for the glob-double-star-selector-drift precondition', () => {
    const entry = MIGRATION_REGISTRY.find((e) => e.transforms.length > 0);
    expect(entry).toBeDefined();
    const pair = entry?.transforms[0];
    expect(pair?.validator).toBe(globDoubleStarSelectorDriftValidator);
    expect(pair?.transform).toBe(globDoubleStarSelectorRewriteTransform);
  });
});

describe('align upgrade — glob-double-star-selector-rewrite, consent granted', () => {
  it('the validator fires, the transform previews the exact change, and consent applies it', async () => {
    tmpDir = await copyCommittedFixture('glob-double-star-drift');
    const questions: string[] = [];
    const confirm = async (question: string): Promise<boolean> => {
      questions.push(question);
      return true;
    };

    const { result: code, logs } = await withCapturedConsole(() => runUpgrade(tmpDir, { nonInteractive: false, confirm }));

    expect(code).toBe(0);
    // The validator's own finding, printed unconditionally (always-run, ADR 022).
    expect(logs.join('\n')).toMatch(/glob-double-star-selector-drift.*1 finding/);
    expect(logs.join('\n')).toContain('app/datamodel.ts');

    // The transform asked for consent with its exact diff in the question text — "preview by
    // default," not applied without being shown first.
    const transformQuestion = questions.find((q) => q.includes('glob-double-star-selector-rewrite'));
    expect(transformQuestion).toBeDefined();
    expect(transformQuestion).toContain("component 'app': 'app/**/model.ts' -> 'app/**model.ts'");

    // And consent actually applied it.
    expect(fs.readFileSync(configPath(tmpDir), 'utf8')).toContain("app: 'app/**model.ts'");

    // No baseline ever existed for this fixture, but the transform WAS actionable and fully
    // reconciled — `baselineReconciledBy` still advances (the fix this task made to
    // `runUpgrade`'s baseline-emptiness short-circuit, which used to skip the transform tier
    // entirely for a repo that had never run `baseline accept`).
    expect(readVersionFile(tmpDir)?.baselineReconciledBy).toBe(ALIGN_VERSION);
  });

  it('idempotent end to end: running upgrade again over the same range finds nothing left to do', async () => {
    tmpDir = await copyCommittedFixture('glob-double-star-drift');
    const alwaysYes = async (): Promise<boolean> => true;

    const first = await runUpgrade(tmpDir, { nonInteractive: false, confirm: alwaysYes });
    expect(first).toBe(0);
    const afterFirst = fs.readFileSync(configPath(tmpDir), 'utf8');
    // Clean tree again for the second run — stages+commits exactly the one file the transform
    // touched, via the same audited rails `initTestGitRepo` uses.
    await createNodeGitEffects(tmpDir).commit('apply transform', [toRepoRelativePath('align.config.ts')]);

    // `alignVersion` already advanced to the running version on the first run, so a plain second
    // call would short-circuit on "already at the current version" without ever re-running the
    // validator/transform at all. `--from` forces the SAME range back into play so this test
    // actually exercises the transform a second time, not just the version-skip fast path.
    const { result: second, logs } = await withCapturedConsole(() =>
      runUpgrade(tmpDir, { nonInteractive: false, confirm: alwaysYes, from: '0.1.0' }),
    );
    expect(second).toBe(0);
    expect(logs.join('\n')).toMatch(/No validator findings for this range/);
    expect(logs.join('\n')).not.toContain('glob-double-star-selector-rewrite');
    expect(fs.readFileSync(configPath(tmpDir), 'utf8')).toBe(afterFirst); // unchanged the second time
  });
});

describe('align upgrade — glob-double-star-selector-rewrite, consent refused', () => {
  it('declining the transform prompt leaves align.config.ts byte-identical', async () => {
    tmpDir = await copyCommittedFixture('glob-double-star-drift');
    const before = fs.readFileSync(configPath(tmpDir), 'utf8');
    const alwaysNo = async (): Promise<boolean> => false;

    const { result: code, logs } = await withCapturedConsole(() => runUpgrade(tmpDir, { nonInteractive: false, confirm: alwaysNo }));

    expect(code).toBe(1);
    expect(fs.readFileSync(configPath(tmpDir), 'utf8')).toBe(before);
    expect(logs.join('\n')).toMatch(/Not fully reconciled/);
    expect(readVersionFile(tmpDir)).toBeUndefined(); // never stamped — nothing was reconciled
  });

  it('non-interactive without --yes refuses the same way, byte-identical', async () => {
    tmpDir = await copyCommittedFixture('glob-double-star-drift');
    const before = fs.readFileSync(configPath(tmpDir), 'utf8');

    const { result: code } = await withCapturedConsole(() => runUpgrade(tmpDir, { nonInteractive: true }));

    expect(code).toBe(1);
    expect(fs.readFileSync(configPath(tmpDir), 'utf8')).toBe(before);
  });
});

describe('align upgrade — glob-double-star-selector-rewrite refuses on a dirty tree, even with --yes', () => {
  it('a dirty working tree blocks the transform without asking, and stamps nothing', async () => {
    tmpDir = await copyCommittedFixture('glob-double-star-drift');
    const before = fs.readFileSync(configPath(tmpDir), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'app', 'datamodel.ts'), '// uncommitted\nexport const dataModel = {};\n', 'utf8');

    const { result: code, logs } = await withCapturedConsole(() => runUpgrade(tmpDir, { nonInteractive: true, yes: true }));

    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(/dirty/);
    expect(fs.readFileSync(configPath(tmpDir), 'utf8')).toBe(before);
    expect(readVersionFile(tmpDir)).toBeUndefined();
  });
});

describe('align upgrade — --notes never applies the transform', () => {
  it('prints the validator finding but leaves align.config.ts untouched', async () => {
    tmpDir = await copyCommittedFixture('glob-double-star-drift');
    const before = fs.readFileSync(configPath(tmpDir), 'utf8');

    const { result: code, logs } = await withCapturedConsole(() => runUpgrade(tmpDir, { notes: true, nonInteractive: true }));

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('app/datamodel.ts');
    expect(fs.readFileSync(configPath(tmpDir), 'utf8')).toBe(before);
  });
});
