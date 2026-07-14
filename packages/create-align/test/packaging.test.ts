/**
 * Packaging verification (mirrors `packages/cli/test/packaging.test.ts`): static checks that the
 * built artifact is wired up to be an installable binary — shebang present, `package.json`'s
 * `"bin"` entry points at a file that actually exists post-build. Skips gracefully (never fails
 * the suite) when `dist/index.js` hasn't been built yet.
 *
 * Deliberately does NOT spawn the binary as a child process — a real install/network-touching
 * spawn is out of scope for this package's test suite by explicit constraint (create-align must
 * never run a real install in tests).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(here, '..');
const distEntry = path.join(packageDir, 'dist', 'index.js');
const built = fs.existsSync(distEntry);

describe.skipIf(!built)('create-align bin — built artifact is packaged correctly', () => {
  it('has a node shebang as its first line', () => {
    const firstLine = fs.readFileSync(distEntry, 'utf8').split('\n')[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  it('is a non-empty, readable file (build actually emitted something, not a stub)', () => {
    const stat = fs.statSync(distEntry);
    expect(stat.size).toBeGreaterThan(0);
  });
});

describe('package.json — bin wiring', () => {
  it('declares a `create-align` bin pointing at dist/index.js', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { bin?: Record<string, string> };
    expect(pkg.bin).toEqual({ 'create-align': './dist/index.js' });
  });

  it('declares zero runtime dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies).toBeUndefined();
  });

  it('has no install/postinstall lifecycle script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.install).toBeUndefined();
    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.scripts?.preinstall).toBeUndefined();
  });

  it("src/index.ts (the compiled entry point's source) starts with a node shebang", () => {
    const source = fs.readFileSync(path.join(packageDir, 'src', 'index.ts'), 'utf8');
    expect(source.split('\n')[0]).toBe('#!/usr/bin/env node');
  });
});
