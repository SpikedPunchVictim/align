import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolvePackageEntrypoints } from '../src/entrypoint.js';
import type { WorkspacePackage } from '../src/workspace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures', 'entrypoint');

function pkg(dirName: string, name = `@fixture/${dirName}`): WorkspacePackage {
  return { name, dir: `${dirName}/` };
}

describe('resolvePackageEntrypoints — package.json:exports (string form)', () => {
  it('resolves a bare-string exports field, remapping dist -> src', () => {
    const entrypoints = resolvePackageEntrypoints(pkg('exports-string'), fixturesDir);
    expect(entrypoints).toEqual([
      {
        confidence: 'declared',
        file: 'exports-string/src/index.ts',
        provenance: { source: 'package.json:exports', conditionPath: '.' },
      },
    ]);
  });
});

describe('resolvePackageEntrypoints — package.json:exports (conditions object, subpaths)', () => {
  it('resolves the root "." condition via the types condition, remapping dist -> src', () => {
    const entrypoints = resolvePackageEntrypoints(pkg('exports-conditions'), fixturesDir);
    const root = entrypoints.find((e) => e.confidence === 'declared' && e.provenance.source === 'package.json:exports' && e.provenance.conditionPath === '.');
    expect(root?.file).toBe('exports-conditions/src/index.ts');
  });

  it('resolves a declared subpath export as its own separate PackageEntrypoint (langchain output_parsers shape)', () => {
    const entrypoints = resolvePackageEntrypoints(pkg('exports-conditions'), fixturesDir);
    const subpath = entrypoints.find(
      (e) => e.confidence === 'declared' && e.provenance.source === 'package.json:exports' && e.provenance.conditionPath === './output_parsers',
    );
    expect(subpath?.file).toBe('exports-conditions/src/output_parsers/index.ts');
  });

  it('never emits an entrypoint for the ./package.json export condition', () => {
    const entrypoints = resolvePackageEntrypoints(pkg('exports-conditions'), fixturesDir);
    expect(entrypoints.some((e) => e.confidence === 'declared' && e.provenance.source === 'package.json:exports' && e.provenance.conditionPath === './package.json')).toBe(false);
  });

  it('resolves exactly 2 declared entrypoints for this fixture (root + subpath, package.json skipped)', () => {
    const entrypoints = resolvePackageEntrypoints(pkg('exports-conditions'), fixturesDir);
    expect(entrypoints).toHaveLength(2);
  });
});

describe('resolvePackageEntrypoints — the "input" condition (langchain regression, ADR 016 §5.3)', () => {
  it('prefers the input condition over import/require, resolving straight to pre-build .ts source with no remap needed', () => {
    const entrypoints = resolvePackageEntrypoints(pkg('exports-input-condition'), fixturesDir);
    const root = entrypoints.find((e) => e.confidence === 'declared' && e.provenance.source === 'package.json:exports' && e.provenance.conditionPath === '.');
    expect(root?.file).toBe('exports-input-condition/src/index.ts');

    const subpath = entrypoints.find(
      (e) => e.confidence === 'declared' && e.provenance.source === 'package.json:exports' && e.provenance.conditionPath === './output_parsers',
    );
    expect(subpath?.file).toBe('exports-input-condition/src/output_parsers/index.ts');
    expect(subpath?.confidence).toBe('declared'); // NOT flagged as an inferred/guessed leak
  });
});

describe('resolvePackageEntrypoints — package.json:types', () => {
  it('resolves via types when exports is absent, remapping dist -> src', () => {
    const entrypoints = resolvePackageEntrypoints(pkg('types-field'), fixturesDir);
    expect(entrypoints).toEqual([
      { confidence: 'declared', file: 'types-field/src/index.ts', provenance: { source: 'package.json:types' } },
    ]);
  });
});

describe('resolvePackageEntrypoints — package.json:main with bundler-infix build output', () => {
  it('resolves "dist/index.cjs.js" back to src/index.ts, stripping the cjs infix (backstage/cli-shaped case)', () => {
    const entrypoints = resolvePackageEntrypoints(pkg('main-field'), fixturesDir);
    expect(entrypoints).toEqual([
      { confidence: 'declared', file: 'main-field/src/index.ts', provenance: { source: 'package.json:main' } },
    ]);
  });
});

describe('resolvePackageEntrypoints — convention fallback (no exports/types/main declared)', () => {
  it('grades a single resolving candidate as inferred-unique (nest-shaped case)', () => {
    const entrypoints = resolvePackageEntrypoints(pkg('convention-unique'), fixturesDir);
    expect(entrypoints).toEqual([
      {
        confidence: 'inferred-unique',
        file: 'convention-unique/src/index.ts',
        provenance: { source: 'convention', candidateCount: 1 },
      },
    ]);
  });

  it('grades zero resolving candidates as inferred-none with file: null', () => {
    const entrypoints = resolvePackageEntrypoints(pkg('convention-none'), fixturesDir);
    expect(entrypoints).toEqual([
      { confidence: 'inferred-none', file: null, provenance: { source: 'convention', candidateCount: 0 } },
    ]);
  });
});

describe('resolvePackageEntrypoints — wildcard subpath exports', () => {
  it('skips a wildcard subpath ("./*") entirely rather than treating it as one concrete entrypoint', () => {
    const entrypoints = resolvePackageEntrypoints(pkg('wildcard-subpath'), fixturesDir);
    expect(entrypoints).toHaveLength(1);
    expect(entrypoints[0]).toEqual({
      confidence: 'declared',
      file: 'wildcard-subpath/src/index.ts',
      provenance: { source: 'package.json:exports', conditionPath: '.' },
    });
  });
});
