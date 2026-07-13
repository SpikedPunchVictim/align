/**
 * Packaging verification (Stage 5, IMPLEMENTATION_PLAN.md "Elevated first items"): static checks
 * that the built artifact is wired up to be an installable binary — shebang present, and
 * `package.json`'s `"bin"` entry points at a file that actually exists post-build. Skips
 * gracefully (never fails the suite) when `dist/index.js` hasn't been built yet — this repo has
 * no fixed build-then-test CI ordering (`pnpm build && pnpm test` is a documented manual step, see
 * root README), so a missing dist/ is a "not built yet" state, not a packaging regression. Same
 * `skipIf` discipline as `packages/agent/test/live-smoke.test.ts`.
 *
 * Deliberately does NOT spawn the binary as a child process here: doing so would need
 * `node:child_process`, which align's own dogfood ruleset now restricts to the audited git rails
 * (`custom.host:no-child-process-outside-git-rails`, `align.config.ts`) — a test file is exactly
 * the kind of case that rule doesn't yet carve an exception for, and this package doesn't own that
 * rule. Real end-to-end execution (`npm link` / `pnpm link --global`, then `align --version`,
 * `align skill`, `align check --json`) was verified manually and is documented in the root
 * README's quickstart.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(here, '..');
const distEntry = path.join(packageDir, 'dist', 'index.js');
const built = fs.existsSync(distEntry);

describe.skipIf(!built)('align bin — built artifact is packaged correctly (see README for live-execution verification)', () => {
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
  it('declares an `align` bin pointing at dist/index.js', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { bin?: Record<string, string> };
    expect(pkg.bin).toEqual({ align: './dist/index.js' });
  });

  it('src/index.ts (the compiled entry point\'s source) starts with a node shebang', () => {
    const source = fs.readFileSync(path.join(packageDir, 'src', 'index.ts'), 'utf8');
    expect(source.split('\n')[0]).toBe('#!/usr/bin/env node');
  });
});
