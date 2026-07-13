import { describe, expect, it } from 'vitest';
import {
  classifyFile,
  ComponentValidationError,
  findUngroundedComponents,
  validateClassifiedComponents,
  validateComponents,
} from '../src/components/registry.js';
import { toComponentName, toRepoRelativePath } from '../src/types/branded.js';
import type { ComponentDefinitionIR, EmptyPolicy } from '../src/types/ir.js';

const glob = (patterns: string[], empty: EmptyPolicy = 'fail'): ComponentDefinitionIR => ({
  name: '',
  selector: { kind: 'glob', patterns },
  empty,
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
