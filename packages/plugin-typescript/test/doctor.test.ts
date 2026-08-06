import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findDeadAliases, findOrphanedPackages } from '../src/doctor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

describe('findDeadAliases', () => {
  it('reports a tsconfig paths alias whose target does not exist on disk', () => {
    const root = path.join(fixturesDir, 'doctor-dead-alias');
    const dead = findDeadAliases(root);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.alias).toBe('@dead/*');
    expect(dead[0]?.target).toBe('./nonexistent/*');
    expect(dead[0]?.tsconfig).toBe('tsconfig.json');
  });

  it('does not report an alias whose target resolves to a real directory', () => {
    const root = path.join(fixturesDir, 'doctor-dead-alias');
    const dead = findDeadAliases(root);
    expect(dead.some((d) => d.alias === '@live/*')).toBe(false);
  });

  it('returns an empty array for a tsconfig with no paths', () => {
    expect(findDeadAliases(path.join(fixturesDir, 'clean'))).toEqual([]);
  });

  it('respects excludes — an excluded directory containing a dead alias is not reported', () => {
    const dead = findDeadAliases(fixturesDir, ['doctor-dead-alias']);
    expect(dead).toEqual([]);
  });
});

describe('findOrphanedPackages', () => {
  it('reports a package.json-having directory not covered by any pnpm-workspace.yaml glob', () => {
    const root = path.join(fixturesDir, 'doctor-orphaned');
    const orphaned = findOrphanedPackages(root);
    expect(orphaned).toEqual([{ dir: 'extra/', name: '@fixture/extra-orphaned' }]);
  });

  it('does not report a package covered by a workspace glob', () => {
    const root = path.join(fixturesDir, 'doctor-orphaned');
    const orphaned = findOrphanedPackages(root);
    expect(orphaned.some((p) => p.name === '@fixture/pkg-a')).toBe(false);
  });

  it('returns an empty array when there is no pnpm-workspace.yaml at all', () => {
    expect(findOrphanedPackages(path.join(fixturesDir, 'clean'))).toEqual([]);
  });
});

describe("doctor excludes now match core's glob dialect exactly (BUG #15)", () => {
  // `isExcluded` used to run a second, independent glob implementation (`globLikeMatch`) that
  // diverged from core's `globMatch` in two ways. It now delegates to core's matcher directly, so
  // doctor's exclude patterns must behave identically to component selectors / the scanner's
  // excludes.
  let dir: string;

  function deadAliasTsconfig(name: string): string {
    return JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { [`@${name}/*`]: ['./nonexistent/*'] } },
    });
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-doctor-excludes-test-'));

    // root-level directory, for the leading `**/` case (divergence 1).
    fs.mkdirSync(path.join(dir, 'generated'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'generated', 'tsconfig.json'), deadAliasTsconfig('generated-dead'));

    // not excluded by any pattern below — sanity check that exclusion is selective, not blanket.
    fs.mkdirSync(path.join(dir, 'keep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'keep', 'tsconfig.json'), deadAliasTsconfig('keep-dead'));

    // nested under `vendor`, only reachable via brace expansion (divergence 2).
    fs.mkdirSync(path.join(dir, 'vendor', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vendor', 'nested', 'tsconfig.json'), deadAliasTsconfig('vendor-nested-dead'));

    // directly under a plain literal directory name, for the kept literal-prefix arms.
    fs.mkdirSync(path.join(dir, 'vendor2'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vendor2', 'tsconfig.json'), deadAliasTsconfig('vendor2-dead'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a leading `**/` exclude also matches a root-level directory (divergence 1: missing segment-boundary handling)', () => {
    const dead = findDeadAliases(dir, ['**/generated']);
    expect(dead.some((d) => d.alias === '@generated-dead/*')).toBe(false);
    expect(dead.some((d) => d.alias === '@keep-dead/*')).toBe(true);
  });

  it('a brace-group exclude pattern now works (divergence 2: no brace expansion)', () => {
    const dead = findDeadAliases(dir, ['{vendor,thirdparty}/**']);
    expect(dead.some((d) => d.alias === '@vendor-nested-dead/*')).toBe(false);
    expect(dead.some((d) => d.alias === '@keep-dead/*')).toBe(true);
  });

  it('a plain literal directory exclude still works (the directory-prefix arms kept alongside globMatch)', () => {
    const dead = findDeadAliases(dir, ['vendor2']);
    expect(dead.some((d) => d.alias === '@vendor2-dead/*')).toBe(false);
    expect(dead.some((d) => d.alias === '@keep-dead/*')).toBe(true);
  });
});
