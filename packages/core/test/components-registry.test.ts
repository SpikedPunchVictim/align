import { describe, expect, it } from 'vitest';
import {
  classifyFile,
  ComponentValidationError,
  findUngroundedComponents,
  validateClassifiedComponents,
  validateComponents,
  validateSelectorSyntax,
} from '../src/components/registry.js';
import { toComponentName, toRepoRelativePath } from '../src/types/branded.js';
import type { ComponentDefinitionIR, EmptyPolicy } from '../src/types/ir.js';
import { blindSpot } from './helpers.js';

const glob = (patterns: string[], empty: EmptyPolicy = 'fail'): ComponentDefinitionIR => ({
  name: '',
  selector: { kind: 'glob', patterns },
  empty,
});

describe('validateSelectorSyntax', () => {
  it('passes a component using the supported glob dialect, including brace expansion', () => {
    const components = { [toComponentName('providers')]: glob(['src/llm-{anthropic,ollama,openai}/**']) };
    expect(() => validateSelectorSyntax(components)).not.toThrow();
  });

  it('throws an actionable ComponentValidationError on unsupported selector syntax', () => {
    const components = { [toComponentName('providers')]: glob(['src/llm-[ao]*/**']) };
    expect(() => validateSelectorSyntax(components)).toThrow(ComponentValidationError);
    expect(() => validateSelectorSyntax(components)).toThrow(/glob dialect does not support/);
  });

  it('lints regardless of empty policy — an empty: allow component cannot hide bad syntax', () => {
    const components = { [toComponentName('providers')]: glob(['!src/**'], 'allow') };
    expect(() => validateSelectorSyntax(components)).toThrow(/negated/);
  });
});

describe('classifyFile', () => {
  it('matches the first component whose glob selector matches, in declared order', () => {
    const components = {
      [toComponentName('api')]: glob(['application/api/**']),
      [toComponentName('ui')]: glob(['application/ui/**']),
    };
    expect(classifyFile(toRepoRelativePath('application/api/routes.ts'), components, new Map())).toBe('api');
    expect(classifyFile(toRepoRelativePath('application/ui/App.tsx'), components, new Map())).toBe('ui');
    expect(classifyFile(toRepoRelativePath('somewhere/else.ts'), components, new Map())).toBeUndefined();
  });

  it('supports package selectors resolved against a workspace index', () => {
    const components = {
      [toComponentName('core')]: { name: '', selector: { kind: 'package' as const, packageNames: ['@x/core'] }, empty: 'fail' as const },
    };
    const workspace = new Map([['@x/core', toRepoRelativePath('packages/core/')]]);
    expect(classifyFile(toRepoRelativePath('packages/core/index.ts'), components, workspace)).toBe('core');
    expect(classifyFile(toRepoRelativePath('packages/other/index.ts'), components, workspace)).toBeUndefined();
  });

  it('a non-root package matches by directory prefix only — a sibling with the same prefix (no slash boundary) does not match', () => {
    const components = {
      [toComponentName('core')]: { name: '', selector: { kind: 'package' as const, packageNames: ['@x/core'] }, empty: 'fail' as const },
    };
    const workspace = new Map([['@x/core', toRepoRelativePath('packages/core/')]]);
    expect(classifyFile(toRepoRelativePath('packages/core/src/index.ts'), components, workspace)).toBe('core');
    // `packages/core-utils/x.ts` shares the literal prefix `packages/core` but is a different
    // package directory — the trailing slash on `dir` is what makes `startsWith` a boundary
    // check rather than a bare string-prefix check.
    expect(classifyFile(toRepoRelativePath('packages/core-utils/x.ts'), components, workspace)).toBeUndefined();
  });

  it('a root workspace package (dir: "") matches every file — startsWith("") is true for any path', () => {
    const components = {
      [toComponentName('root')]: { name: '', selector: { kind: 'package' as const, packageNames: ['rootpkg'] }, empty: 'fail' as const },
    };
    const workspace = new Map([['rootpkg', toRepoRelativePath('')]]);
    expect(classifyFile(toRepoRelativePath('src/index.ts'), components, workspace)).toBe('root');
    expect(classifyFile(toRepoRelativePath('packages/other/index.ts'), components, workspace)).toBe('root');
    expect(classifyFile(toRepoRelativePath('package.json'), components, workspace)).toBe('root');
  });

  it('first-match-wins: a root package declared first swallows files that a later component would otherwise claim', () => {
    const components = {
      [toComponentName('root')]: { name: '', selector: { kind: 'package' as const, packageNames: ['rootpkg'] }, empty: 'fail' as const },
      [toComponentName('ui')]: glob(['packages/ui/**']),
    };
    const workspace = new Map([['rootpkg', toRepoRelativePath('')]]);
    // Declared first, so it claims everything — including files a later `ui` selector would match.
    expect(classifyFile(toRepoRelativePath('packages/ui/App.tsx'), components, workspace)).toBe('root');
  });

  it('first-match-wins: a root package declared last leaves earlier components their own files', () => {
    const components = {
      [toComponentName('ui')]: glob(['packages/ui/**']),
      [toComponentName('root')]: { name: '', selector: { kind: 'package' as const, packageNames: ['rootpkg'] }, empty: 'fail' as const },
    };
    const workspace = new Map([['rootpkg', toRepoRelativePath('')]]);
    expect(classifyFile(toRepoRelativePath('packages/ui/App.tsx'), components, workspace)).toBe('ui');
    expect(classifyFile(toRepoRelativePath('other/thing.ts'), components, workspace)).toBe('root');
  });
});

// Greenfield mode's empty-policy matrix (IMPLEMENTATION_PLAN.md Design Reserve, ADR 003
// amendment): the 3-state `empty` discriminant replaces the old boolean `allowEmpty` at the IR
// level. `validateComponents`/`validateClassifiedComponents` only special-case `'fail'` (the
// default, unchanged safety); `'allow'` and `'until-populated'` behave identically at THIS layer
// (never throw on empty) — they differ only in `findUngroundedComponents`'s reporting (both
// surfaced) and, via `align doctor`, whether a "remove the marker" advisory ever fires. The
// "populated" quadrant (a component with files) isn't a validation-layer distinction at all: once
// any file classifies, the empty checks simply never trigger for that component, `'until-populated'`
// or not — there is no separate "armed" state (R2's auto-arm requirement falls out of this by
// construction, not by extra bookkeeping).
describe('validateComponents (selector-based, TypeScript scanner-facing)', () => {
  it("'fail' (default): throws for a component whose selector matches zero files", () => {
    const components = { [toComponentName('empty')]: glob(['nowhere/**']) };
    expect(() => validateComponents(components, [toRepoRelativePath('a.ts')], new Map())).toThrow(ComponentValidationError);
  });

  it("'allow': does not throw when the component matches zero files", () => {
    const components = { [toComponentName('empty')]: glob(['nowhere/**'], 'allow') };
    expect(() => validateComponents(components, [toRepoRelativePath('a.ts')], new Map())).not.toThrow();
  });

  it("'until-populated': does not throw when the component currently matches zero files", () => {
    const components = { [toComponentName('empty')]: glob(['nowhere/**'], 'until-populated') };
    expect(() => validateComponents(components, [toRepoRelativePath('a.ts')], new Map())).not.toThrow();
  });

  it("'until-populated': does not throw once the component has matching files (populated — never armed against real files)", () => {
    const components = { [toComponentName('api')]: glob(['api/**'], 'until-populated') };
    expect(() => validateComponents(components, [toRepoRelativePath('api/a.ts')], new Map())).not.toThrow();
  });

  it('the error message documents both new spellings and the deprecated allowEmpty alias', () => {
    const components = { [toComponentName('empty')]: glob(['nowhere/**']) };
    try {
      validateComponents(components, [toRepoRelativePath('a.ts')], new Map());
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ComponentValidationError);
      const message = (err as ComponentValidationError).message;
      expect(message).toContain("empty: 'until-populated'");
      expect(message).toContain("empty: 'allow'");
      expect(message).toContain('allowEmpty');
    }
  });

  it('throws for a package selector naming a package absent from the workspace inventory', () => {
    const components = {
      [toComponentName('core')]: { name: '', selector: { kind: 'package' as const, packageNames: ['@x/missing'] }, empty: 'fail' as const },
    };
    expect(() => validateComponents(components, [toRepoRelativePath('a.ts')], new Map())).toThrow(ComponentValidationError);
  });

  // Task #25's empty-component interaction: a component matching zero files because its files all
  // live under an auto-excluded nested checkout must NOT read as an ordinary stale-selector error —
  // this is the ONE path such information can reach the user at all when `empty: 'fail'` (default),
  // since the thrown error aborts the check as a `parse`-gate `error` before the sibling
  // `nested-checkout-skipped` advisory (built from the same scan) ever gets attached (orchestrator's
  // `scanAll` catch has no graph to build an advisory from).
  it('names a skipped nested checkout as the likely cause instead of the generic "renamed/moved/stale" message', () => {
    const components = { [toComponentName('vendor')]: glob(['vendor/submodule/**']) };
    try {
      validateComponents(components, [toRepoRelativePath('a.ts')], new Map(), [blindSpot('vendor/submodule')]);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ComponentValidationError);
      const message = (err as ComponentValidationError).message;
      expect(message).toContain('vendor/submodule');
      expect(message).toContain('nested git checkout');
      expect(message).toContain('this scan did not look at');
      expect(message).toContain('includeNestedCheckouts');
      expect(message).not.toContain('renamed/moved');
    }
  });

  // Found by the ADR 028 Stage 1 review. `blindSpotsMatchingSelector` counts EVERY blind spot as a
  // likely cause for a selector with no literal anchor (`**` has an empty static prefix, so it could
  // match anywhere), and a real repo records hundreds — 200 measured on align's own tree. Uncapped,
  // this one component's zero-match error carried the entire scan-scope record as prose.
  it('caps the named blind spots in the thrown message rather than joining all of them', () => {
    // `**/*.generated.ts` matches no file here, and `staticPrefixOf` gives it an EMPTY literal
    // anchor — which is what makes every blind spot count as a likely cause.
    const components = { [toComponentName('generated')]: glob(['**/*.generated.ts']) };
    const many = Array.from({ length: 12 }, (_, i) => blindSpot(`vendor/c${String(i).padStart(2, '0')}`));
    try {
      validateComponents(components, [toRepoRelativePath('a.ts')], new Map(), many);
      expect.fail('expected throw');
    } catch (err) {
      const message = (err as ComponentValidationError).message;
      expect(message).toContain('vendor/c00');
      expect(message).toContain('+7 more');
      expect(message).not.toContain('vendor/c11');
    }
  });

  it('names the checkout even when the selector points DEEPER inside it than the checkout root (the likelier real shape for a vendored checkout)', () => {
    // The probe-file test alone (`${dir}/__align_probe__.ts`) cannot catch this: the selector's
    // literal prefix ('vendored/repo/src') is a full path segment past the checkout root
    // ('vendored/repo'), so a probe placed directly at the checkout root never matches. The
    // static-prefix-containment test is what catches it instead.
    const components = { [toComponentName('vendored')]: glob(['vendored/repo/src/**']) };
    try {
      validateComponents(components, [toRepoRelativePath('a.ts')], new Map(), [blindSpot('vendored/repo')]);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ComponentValidationError);
      const message = (err as ComponentValidationError).message;
      expect(message).toContain('vendored/repo');
      expect(message).toContain('this scan did not look at');
      expect(message).not.toContain('renamed/moved');
    }
  });

  it('falls back to the generic message when a skipped checkout exists but does not overlap the selector', () => {
    const components = { [toComponentName('empty')]: glob(['nowhere/**']) };
    try {
      validateComponents(components, [toRepoRelativePath('a.ts')], new Map(), [toRepoRelativePath('unrelated/checkout')]);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ComponentValidationError);
      const message = (err as ComponentValidationError).message;
      expect(message).toContain('renamed/moved');
      expect(message).not.toContain('unrelated/checkout');
    }
  });

  it("'allow'/'until-populated' components are unaffected by skipped checkouts — they never throw regardless", () => {
    const components = { [toComponentName('vendor')]: glob(['vendor/submodule/**'], 'allow') };
    expect(() =>
      validateComponents(components, [toRepoRelativePath('a.ts')], new Map(), [toRepoRelativePath('vendor/submodule')]),
    ).not.toThrow();
  });
});

describe('validateClassifiedComponents (classification-based, orchestrator-facing)', () => {
  it('does not throw when every component has at least one classified file', () => {
    const components = { [toComponentName('api')]: glob(['api/**']), [toComponentName('ui')]: glob(['ui/**']) };
    expect(() => validateClassifiedComponents(components, new Set(['api', 'ui']))).not.toThrow();
  });

  it("'fail': throws for a component with zero classified files, naming it, its selector, and both opt-outs", () => {
    const components = { [toComponentName('api')]: glob(['api/**']), [toComponentName('ui')]: glob(['ui/**']) };
    try {
      validateClassifiedComponents(components, new Set(['api']));
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ComponentValidationError);
      const e = err as ComponentValidationError;
      expect(e.componentName).toBe('ui');
      expect(e.message).toContain("'ui'");
      expect(e.message).toContain('ui/**');
      expect(e.message).toContain("empty: 'until-populated'");
      expect(e.message).toContain("empty: 'allow'");
      expect(e.message).toContain('allowEmpty');
      expect(e.message).toContain('first-match-wins');
    }
  });

  it("'allow': does not throw for a zero-classified-files component", () => {
    const components = { [toComponentName('ui')]: glob(['ui/**'], 'allow') };
    expect(() => validateClassifiedComponents(components, new Set())).not.toThrow();
  });

  it("'until-populated': does not throw for a zero-classified-files component", () => {
    const components = { [toComponentName('ui')]: glob(['ui/**'], 'until-populated') };
    expect(() => validateClassifiedComponents(components, new Set())).not.toThrow();
  });

  it('catches a component fully shadowed by an earlier first-match-wins selector (invisible to selector-based validateComponents)', () => {
    const components = {
      [toComponentName('catchall')]: glob(['src/**']),
      [toComponentName('api')]: glob(['src/api/**']),
    };
    const files = [toRepoRelativePath('src/api/a.ts')];
    // Selector-based validation passes — `api`'s glob DOES match a file...
    expect(() => validateComponents(components, files, new Map())).not.toThrow();
    // ...but classification gives that file to `catchall` (declared first), so `api` is empty.
    const classified = new Set(files.map((f) => String(classifyFile(f, components, new Map()))));
    expect(() => validateClassifiedComponents(components, classified)).toThrow(ComponentValidationError);
  });
});

describe('findUngroundedComponents (R1: greenfield mode ungrounded-green surfacing)', () => {
  it("returns nothing for a 'fail' component — it would have thrown before this ever runs", () => {
    const components = { [toComponentName('api')]: glob(['api/**']) };
    expect(findUngroundedComponents(components, new Set())).toEqual([]);
  });

  it("returns nothing for any component with >=1 classified file, regardless of policy", () => {
    const components = {
      [toComponentName('api')]: glob(['api/**'], 'allow'),
      [toComponentName('ui')]: glob(['ui/**'], 'until-populated'),
    };
    expect(findUngroundedComponents(components, new Set(['api', 'ui']))).toEqual([]);
  });

  it("surfaces an 'allow' component with zero classified files, with its name/selector/policy", () => {
    const components = { [toComponentName('plugins')]: glob(['src/plugins/**'], 'allow') };
    expect(findUngroundedComponents(components, new Set())).toEqual([
      { name: 'plugins', selector: 'src/plugins/**', policy: 'allow' },
    ]);
  });

  it("surfaces an 'until-populated' component with zero classified files, with its name/selector/policy", () => {
    const components = { [toComponentName('api')]: glob(['src/api/**'], 'until-populated') };
    expect(findUngroundedComponents(components, new Set())).toEqual([
      { name: 'api', selector: 'src/api/**', policy: 'until-populated' },
    ]);
  });

  it('surfaces multiple ungrounded components independently of grounded ones in the same registry', () => {
    const components = {
      [toComponentName('core')]: glob(['core/**']),
      [toComponentName('api')]: glob(['api/**'], 'until-populated'),
      [toComponentName('storage')]: glob(['storage/**'], 'until-populated'),
    };
    const result = findUngroundedComponents(components, new Set(['core']));
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name).sort()).toEqual(['api', 'storage']);
  });
});
