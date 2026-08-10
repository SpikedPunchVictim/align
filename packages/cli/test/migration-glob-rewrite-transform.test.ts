import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { initTestGitRepo } from '@spikedpunch/align-agent';
import { globDoubleStarSelectorRewriteTransform } from '../src/migrations/transforms/glob-double-star-rewrite.js';

// `glob-double-star-selector-rewrite` (ADR 022, task #16 slice E): the transform paired with the
// `glob-double-star-selector-drift` validator. Exercised directly (not through `align upgrade`'s
// consent machinery, which `upgrade-transform.test.ts` covers) so `preview`/`apply`'s own refusal
// logic is tested against real git repos and a real `align.config.ts` on disk.
//
// Real git repos are bootstrapped via `@spikedpunch/align-agent`'s `initTestGitRepo` rather than a
// local `node:child_process` shell-out — `cli`'s own dogfooded architecture rule
// (`cannotDependOn(external('node:child_process'))`, align.config.ts, ADR 017 Part A) forbids that
// import from anywhere under `packages/cli/**`, tests included; `initTestGitRepo` keeps every real
// git shell-out confined to align-agent's already-audited rails file (`packages/agent/src/git.ts`).

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');
let tmpDir: string;

function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

/** Copies a fixture into a fresh temp dir, symlinks align-core in (same technique every other
 * migration/upgrade test file uses), and commits it as a clean git repo — the transform's own
 * "dirty working tree" refusal needs a REAL repo to refuse against. */
async function copyCommittedFixture(name: string): Promise<string> {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-glob-rewrite-transform-test-'));
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

describe('glob-double-star-selector-rewrite — ready path', () => {
  it('preview shows the exact old -> new diff', async () => {
    tmpDir = await copyCommittedFixture('glob-double-star-drift');
    const preview = await globDoubleStarSelectorRewriteTransform.preview(tmpDir);
    expect(preview.status).toBe('ready');
    expect(preview.description).toContain("component 'app': 'app/**/model.ts' -> 'app/**model.ts'");
    expect(preview.filesAffected).toEqual(['align.config.ts']);
  });

  it('preview never writes anything, no matter how many times it is called', async () => {
    tmpDir = await copyCommittedFixture('glob-double-star-drift');
    const before = fs.readFileSync(configPath(tmpDir), 'utf8');
    await globDoubleStarSelectorRewriteTransform.preview(tmpDir);
    await globDoubleStarSelectorRewriteTransform.preview(tmpDir);
    expect(fs.readFileSync(configPath(tmpDir), 'utf8')).toBe(before);
  });

  it('apply rewrites exactly the drifted pattern literal, leaving everything else byte-identical', async () => {
    tmpDir = await copyCommittedFixture('glob-double-star-drift');
    const before = fs.readFileSync(configPath(tmpDir), 'utf8');

    await globDoubleStarSelectorRewriteTransform.apply(tmpDir);

    const after = fs.readFileSync(configPath(tmpDir), 'utf8');
    expect(after).not.toBe(before);
    expect(after).toBe(before.replace("'app/**/model.ts'", "'app/**model.ts'"));
    expect(after).toContain("app: 'app/**model.ts'");
  });

  it('idempotent: applying twice equals applying once', async () => {
    tmpDir = await copyCommittedFixture('glob-double-star-drift');
    await globDoubleStarSelectorRewriteTransform.apply(tmpDir);
    const afterFirst = fs.readFileSync(configPath(tmpDir), 'utf8');

    const secondPreview = await globDoubleStarSelectorRewriteTransform.preview(tmpDir);
    expect(secondPreview.status).toBe('nothing-to-do');

    await globDoubleStarSelectorRewriteTransform.apply(tmpDir);
    const afterSecond = fs.readFileSync(configPath(tmpDir), 'utf8');
    expect(afterSecond).toBe(afterFirst);
  });
});

describe('glob-double-star-selector-rewrite — nothing to do', () => {
  it('preview reports nothing-to-do and apply is a byte-identical no-op when there is no drift', async () => {
    tmpDir = await copyCommittedFixture('simple-app'); // trailing `**` only — unaffected
    const before = fs.readFileSync(configPath(tmpDir), 'utf8');

    const preview = await globDoubleStarSelectorRewriteTransform.preview(tmpDir);
    expect(preview.status).toBe('nothing-to-do');
    expect(preview.filesAffected).toEqual([]);

    await globDoubleStarSelectorRewriteTransform.apply(tmpDir);
    expect(fs.readFileSync(configPath(tmpDir), 'utf8')).toBe(before);
  });
});

describe('glob-double-star-selector-rewrite — refuses rather than guesses', () => {
  it('refuses when the same drifted literal is ambiguous (shared across two components)', async () => {
    tmpDir = await copyCommittedFixture('glob-double-star-drift-ambiguous');
    const before = fs.readFileSync(configPath(tmpDir), 'utf8');

    const preview = await globDoubleStarSelectorRewriteTransform.preview(tmpDir);
    expect(preview.status).toBe('refused');
    expect(preview.description).toMatch(/more than once/);
    expect(preview.filesAffected).toEqual([]);

    await globDoubleStarSelectorRewriteTransform.apply(tmpDir);
    expect(fs.readFileSync(configPath(tmpDir), 'utf8')).toBe(before); // untouched
  });

  it('refuses when the pattern literal cannot be located (it is computed, not a plain string)', async () => {
    tmpDir = await copyCommittedFixture('glob-double-star-drift-unlocatable');
    const before = fs.readFileSync(configPath(tmpDir), 'utf8');

    const preview = await globDoubleStarSelectorRewriteTransform.preview(tmpDir);
    expect(preview.status).toBe('refused');
    expect(preview.description).toMatch(/could not locate/);

    await globDoubleStarSelectorRewriteTransform.apply(tmpDir);
    expect(fs.readFileSync(configPath(tmpDir), 'utf8')).toBe(before); // untouched
  });

  it('refuses on a dirty working tree, even when the dirt is in an unrelated file', async () => {
    tmpDir = await copyCommittedFixture('glob-double-star-drift');
    const before = fs.readFileSync(configPath(tmpDir), 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'app', 'datamodel.ts'), '// uncommitted change\nexport const dataModel = {};\n', 'utf8');

    const preview = await globDoubleStarSelectorRewriteTransform.preview(tmpDir);
    expect(preview.status).toBe('refused');
    expect(preview.description).toMatch(/dirty/);

    await globDoubleStarSelectorRewriteTransform.apply(tmpDir);
    expect(fs.readFileSync(configPath(tmpDir), 'utf8')).toBe(before); // config itself untouched
  });

  it('refuses when the directory is not a git repository at all (no escape hatch to protect)', async () => {
    // Deliberately NOT using copyCommittedFixture — plain copy, no `git init`.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-glob-rewrite-transform-test-'));
    fs.cpSync(path.join(fixturesDir, 'glob-double-star-drift'), tmpDir, { recursive: true });
    linkAlignCore(tmpDir);
    const before = fs.readFileSync(configPath(tmpDir), 'utf8');

    const preview = await globDoubleStarSelectorRewriteTransform.preview(tmpDir);
    expect(preview.status).toBe('refused');

    await globDoubleStarSelectorRewriteTransform.apply(tmpDir);
    expect(fs.readFileSync(configPath(tmpDir), 'utf8')).toBe(before);
  });
});
