import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
