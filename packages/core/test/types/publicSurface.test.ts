import { describe, expect, it } from 'vitest';
import {
  packageEntrypointSchema,
  packagePublicSurfaceSchema,
  toRepoRelativePath,
  type PackageEntrypoint,
  type PackagePublicSurface,
} from '../../src/index.js';

describe('PackageEntrypoint (discriminated union on confidence, ADR 016)', () => {
  it('accepts a declared entrypoint with a resolved file and package.json:exports provenance', () => {
    const raw = {
      confidence: 'declared',
      file: 'packages/foo/src/index.ts',
      provenance: { source: 'package.json:exports', conditionPath: '.' },
    };
    const parsed = packageEntrypointSchema.parse(raw);
    expect(parsed.confidence).toBe('declared');
    expect(parsed.file).toBe(toRepoRelativePath('packages/foo/src/index.ts'));
  });

  it('accepts a declared subpath entrypoint (langchain output_parsers shape)', () => {
    const raw = {
      confidence: 'declared',
      file: 'libs/langchain-core/src/output_parsers/index.ts',
      provenance: { source: 'package.json:exports', conditionPath: './output_parsers' },
    };
    expect(() => packageEntrypointSchema.parse(raw)).not.toThrow();
  });

  it('accepts a declared entrypoint via package.json:types with no conditionPath', () => {
    const raw = {
      confidence: 'declared',
      file: 'packages/foo/src/index.ts',
      provenance: { source: 'package.json:types' },
    };
    expect(() => packageEntrypointSchema.parse(raw)).not.toThrow();
  });

  it('accepts an inferred-unique entrypoint with a resolved file and candidateCount 1', () => {
    const raw = {
      confidence: 'inferred-unique',
      file: 'packages/bar/index.ts',
      provenance: { source: 'convention', candidateCount: 1 },
    };
    const parsed = packageEntrypointSchema.parse(raw);
    expect(parsed.confidence).toBe('inferred-unique');
  });

  it('accepts an inferred-none entrypoint with file: null and candidateCount 0', () => {
    const raw = {
      confidence: 'inferred-none',
      file: null,
      provenance: { source: 'convention', candidateCount: 0 },
    };
    expect(() => packageEntrypointSchema.parse(raw)).not.toThrow();
  });

  it('rejects a declared entrypoint with file: null (illegal state, ADR 016 discriminated union)', () => {
    const raw = {
      confidence: 'declared',
      file: null,
      provenance: { source: 'package.json:exports', conditionPath: '.' },
    };
    expect(() => packageEntrypointSchema.parse(raw)).toThrow();
  });

  it('rejects an inferred-none entrypoint carrying a resolved file (illegal state)', () => {
    const raw = {
      confidence: 'inferred-none',
      file: 'packages/bar/index.ts',
      provenance: { source: 'convention', candidateCount: 0 },
    };
    expect(() => packageEntrypointSchema.parse(raw)).toThrow();
  });

  it('rejects a declared entrypoint carrying ConventionProvenance (provenance/confidence must agree)', () => {
    const raw = {
      confidence: 'declared',
      file: 'packages/foo/src/index.ts',
      provenance: { source: 'convention', candidateCount: 1 },
    };
    expect(() => packageEntrypointSchema.parse(raw)).toThrow();
  });

  it('rejects an unknown confidence discriminant', () => {
    const raw = { confidence: 'guessed', file: null, provenance: { source: 'convention', candidateCount: 0 } };
    expect(() => packageEntrypointSchema.parse(raw)).toThrow();
  });

  // Compile-time illegal-states-unrepresentable check: a 'declared' entrypoint's `file` is typed
  // RepoRelativePath (never null) — this would be a type error if the union collapsed to optional
  // fields instead of a true discriminated union.
  it('type-level: a declared entrypoint always types file as non-null', () => {
    const entrypoint: PackageEntrypoint = {
      confidence: 'declared',
      file: toRepoRelativePath('packages/foo/src/index.ts'),
      provenance: { source: 'package.json:main' },
    };
    expect(entrypoint.file).not.toBeNull();
  });
});

describe('PackagePublicSurface (ADR 016 full round-trip)', () => {
  it('round-trips a package with a declared entrypoint, resolved exports, and an uncertainty marker', () => {
    const raw: PackagePublicSurface = {
      packageName: '@fixture/pkg',
      entrypoints: [
        {
          confidence: 'declared',
          file: toRepoRelativePath('packages/pkg/src/index.ts'),
          provenance: { source: 'package.json:exports', conditionPath: '.' },
        },
      ],
      exports: [
        {
          symbol: 'foo',
          declaredIn: toRepoRelativePath('packages/pkg/src/index.ts'),
          reachableVia: [],
          confidence: 'declared',
        },
        {
          symbol: 'bar',
          declaredIn: toRepoRelativePath('packages/pkg/src/inner.ts'),
          reachableVia: [toRepoRelativePath('packages/pkg/src/inner.ts')],
          confidence: 'inferred-none',
        },
      ],
      uncertain: [{ file: toRepoRelativePath('packages/pkg/src/index.ts'), reason: 'unresolvable-reexport' }],
    };
    const parsed = packagePublicSurfaceSchema.parse(raw);
    expect(parsed.packageName).toBe('@fixture/pkg');
    expect(parsed.exports).toHaveLength(2);
    expect(parsed.uncertain[0]?.reason).toBe('unresolvable-reexport');
  });

  it('rejects an unknown SurfaceUncertaintyReason', () => {
    const raw = {
      packageName: '@fixture/pkg',
      entrypoints: [],
      exports: [],
      uncertain: [{ file: 'packages/pkg/src/index.ts', reason: 'not-a-real-reason' }],
    };
    expect(() => packagePublicSurfaceSchema.parse(raw)).toThrow();
  });
});
