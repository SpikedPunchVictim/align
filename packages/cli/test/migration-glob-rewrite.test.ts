import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findAffectedGlobDoubleStarSelectors, rewriteInteriorDoubleStar } from '../src/migrations/glob-double-star-shared.js';

// `rewriteInteriorDoubleStar` and `findAffectedGlobDoubleStarSelectors` (ADR 022, task #16 slice
// E): the mechanical rewrite the `glob-double-star-selector-rewrite` transform is built on, tested
// in isolation from the transform's file-editing/consent machinery.

describe('rewriteInteriorDoubleStar', () => {
  it('drops the slash after a single interior `**` token', () => {
    expect(rewriteInteriorDoubleStar('app/**/model.ts')).toBe('app/**model.ts');
  });

  it('drops the slash after a leading interior `**` token', () => {
    expect(rewriteInteriorDoubleStar('**/index.ts')).toBe('**index.ts');
  });

  it('rewrites every interior occurrence in a pattern with more than one', () => {
    expect(rewriteInteriorDoubleStar('a/**/b/**/c')).toBe('a/**b/**c');
  });

  it('leaves a trailing `**` (no following `/`) unchanged', () => {
    expect(rewriteInteriorDoubleStar('src/**')).toBe('src/**');
  });

  it('leaves a `**` followed by a non-slash character unchanged (not an interior token)', () => {
    expect(rewriteInteriorDoubleStar('src/**.ts')).toBe('src/**.ts');
  });

  it('leaves a pattern with no `**` at all unchanged', () => {
    expect(rewriteInteriorDoubleStar('src/*.ts')).toBe('src/*.ts');
  });

  // The pathological case a blind `pattern.split('**/').join('**')` gets wrong: the tokenizer
  // greedily consumes the FIRST two `*` as one `**` token; the third `*` is an unrelated
  // single-star token immediately followed by a literal `/`, not an interior `**` token. A naive
  // substring replace would still find "**" + "/" in here and corrupt it.
  it('does not touch a false-positive substring match inside an adjacent-star run', () => {
    expect(rewriteInteriorDoubleStar('a/***/b')).toBe('a/***/b');
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');
let tmpDir: string;

function linkAlignCore(dest: string): void {
  const scopeDir = path.join(dest, 'node_modules', '@spikedpunch');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(path.join(here, '..', '..', 'core'), path.join(scopeDir, 'align-core'), 'dir');
}

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-migration-rewrite-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  linkAlignCore(dest);
  return dest;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('findAffectedGlobDoubleStarSelectors', () => {
  it('reports a verified rewrite for a real drifted selector', async () => {
    tmpDir = copyFixture('glob-double-star-drift');
    const affected = await findAffectedGlobDoubleStarSelectors(tmpDir);
    expect(affected).toHaveLength(1);
    expect(affected[0]?.component).toBe('app');
    expect(affected[0]?.pattern).toBe('app/**/model.ts');
    expect(affected[0]?.rewritten).toBe('app/**model.ts');
    expect(affected[0]?.verifiedRewrite).toBe(true);
    expect(affected[0]?.lost).toContain('app/datamodel.ts');
  });

  it('reports one entry per component when the identical drifted pattern is shared across two components', async () => {
    tmpDir = copyFixture('glob-double-star-drift-ambiguous');
    const affected = await findAffectedGlobDoubleStarSelectors(tmpDir);
    expect(affected.map((a) => a.component).sort()).toEqual(['app', 'app2']);
    expect(affected.every((a) => a.pattern === 'app/**/model.ts')).toBe(true);
    expect(affected.every((a) => a.verifiedRewrite)).toBe(true);
  });

  it('reports the drifted selector even when the source literal is computed (detection does not depend on locatability)', async () => {
    tmpDir = copyFixture('glob-double-star-drift-unlocatable');
    const affected = await findAffectedGlobDoubleStarSelectors(tmpDir);
    expect(affected).toHaveLength(1);
    expect(affected[0]?.pattern).toBe('app/**/model.ts');
    expect(affected[0]?.verifiedRewrite).toBe(true);
  });

  it('returns [] when nothing has an interior `**`', async () => {
    tmpDir = copyFixture('simple-app');
    expect(await findAffectedGlobDoubleStarSelectors(tmpDir)).toEqual([]);
  });

  it('returns [] (not a throw) when the config fails to load', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-migration-rewrite-test-'));
    expect(await findAffectedGlobDoubleStarSelectors(tmpDir)).toEqual([]);
  });
});
