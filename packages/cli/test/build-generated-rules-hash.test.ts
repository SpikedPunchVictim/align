import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@spikedpunch/align-core';
import { afterEach, describe, expect, it } from 'vitest';
import { runBuild, verifyFrozenRules } from '../src/commands/build.js';
import { generatedRulesPath, readRulesLock, writeRulesLock } from '../src/align-dir.js';

// ADR 011 amendment (2026-08-12, docs/adr/011-2026-07-11-rules-build-markdown-source.md): the defect this
// covers was `generatedRulesContentHash = sha256Hex(rawWritten)` (`build.ts`, pre-fix) — hashing the
// WHOLE `.align/generated-rules.json` file, including `generatedAt: Date.now()`. Two builds of
// byte-identical rules produced different hashes, silently defeating "rebuild and compare." The fix
// hashes an explicitly reconstructed `{ irVersion, docPath, rules }` (`reproducibleGeneratedRulesHash`,
// `commands/build.ts`) instead of the raw bytes, and `verifyFrozenRules` falls back to the OLD
// raw-bytes comparison for a lockfile written before this change, so an untouched repo upgrading
// align is never falsely told its rules were hand-edited (`checkGeneratedRulesDivergence`,
// `commands/build.ts`). Sibling to `build.test.ts`, which is already near the 456-line mark this
// suite keeps itself away from (docs/ARCHITECTURE-RULES.md's 500-line-per-`cli`-file rule applies to
// source, not tests, but a new concern gets a new file either way).

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

let tmpDir: string;

function copyFixture(name: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'align-build-hash-test-'));
  fs.cpSync(path.join(fixturesDir, name), dest, { recursive: true });
  return dest;
}

afterEach(() => {
  if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function apply(dir: string): Promise<void> {
  const code = await runBuild(dir, { apply: true, ifChanged: false, verify: false, acceptNewIntoBaseline: false });
  expect(code).toBe(0);
}

describe('generated-rules.json hash reproducibility (ADR 011 amendment 2026-08-12)', () => {
  it('two consecutive `build --apply` runs over identical input produce an IDENTICAL generatedRulesContentHash', async () => {
    tmpDir = copyFixture('build-app');
    await apply(tmpDir);
    const lock1 = readRulesLock(tmpDir);
    const raw1 = fs.readFileSync(generatedRulesPath(tmpDir), 'utf8');
    expect(lock1).toBeDefined();

    // A real clock tick between builds, so `generatedAt` is provably different the second time —
    // otherwise an equal hash could just mean the millisecond didn't advance, not that the fix works.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await apply(tmpDir);
    const lock2 = readRulesLock(tmpDir);
    const raw2 = fs.readFileSync(generatedRulesPath(tmpDir), 'utf8');
    expect(lock2).toBeDefined();

    // Sanity: the raw bytes DID change (generatedAt moved forward) — proving the hash equality
    // below is the reproducibility property, not an accidental no-op rebuild.
    expect(raw2).not.toBe(raw1);
    expect(lock2?.generatedRulesContentHash).toBe(lock1?.generatedRulesContentHash);
  });

  it('a real semantic edit to generated-rules.json is still detected as divergence', async () => {
    tmpDir = copyFixture('build-app');
    await apply(tmpDir);
    expect(verifyFrozenRules(tmpDir).ok).toBe(true);

    const generated = JSON.parse(fs.readFileSync(generatedRulesPath(tmpDir), 'utf8')) as {
      rules: Array<Record<string, unknown>>;
    };
    const idx = generated.rules.findIndex((r) => r.kind === 'arch.no-dependency');
    expect(idx).toBeGreaterThanOrEqual(0);
    generated.rules[idx] = { ...generated.rules[idx], to: 'renamed-component' };
    fs.writeFileSync(generatedRulesPath(tmpDir), `${JSON.stringify(generated, null, 2)}\n`, 'utf8');

    const result = verifyFrozenRules(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.advisories.some((a) => a.kind === 'divergence')).toBe(true);
    expect(result.advisories.some((a) => a.kind === 'lockfile-predates-reproducible-hash')).toBe(false);
  });

  it('a lockfile carrying the legacy raw-bytes hash yields the "predates" advisory, not the tampering one', async () => {
    tmpDir = copyFixture('build-app');
    await apply(tmpDir);
    const lock = readRulesLock(tmpDir);
    expect(lock).toBeDefined();

    // Simulates exactly what pre-fix align wrote into rules.lock.json: sha256Hex of the raw file
    // bytes (generatedAt included), never rewritten by this repro (the file on disk is unchanged).
    const rawGenerated = fs.readFileSync(generatedRulesPath(tmpDir), 'utf8');
    writeRulesLock(tmpDir, { ...lock!, generatedRulesContentHash: sha256Hex(rawGenerated) });

    const result = verifyFrozenRules(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.advisories.some((a) => a.kind === 'lockfile-predates-reproducible-hash')).toBe(true);
    expect(result.advisories.some((a) => a.kind === 'divergence')).toBe(false);
  });

  it('a lockfile hash matching NEITHER scheme is still reported as real divergence (tampering)', async () => {
    tmpDir = copyFixture('build-app');
    await apply(tmpDir);
    const lock = readRulesLock(tmpDir);
    expect(lock).toBeDefined();

    writeRulesLock(tmpDir, { ...lock!, generatedRulesContentHash: 'deadbeef'.repeat(8) });

    const result = verifyFrozenRules(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.advisories.some((a) => a.kind === 'divergence')).toBe(true);
    expect(result.advisories.some((a) => a.kind === 'lockfile-predates-reproducible-hash')).toBe(false);
  });

  it('a corrupted (invalid-JSON) generated-rules.json is reported as divergence, not thrown', async () => {
    tmpDir = copyFixture('build-app');
    await apply(tmpDir);
    fs.writeFileSync(generatedRulesPath(tmpDir), '{ not valid json', 'utf8');

    const result = verifyFrozenRules(tmpDir);
    expect(result.ok).toBe(false);
    expect(result.advisories.some((a) => a.kind === 'divergence')).toBe(true);
  });
});
