import { describe, expect, it } from 'vitest';
import { classifyFile, ComponentValidationError, validateClassifiedComponents, validateComponents } from '../src/components/registry.js';
import { toComponentName, toRepoRelativePath } from '../src/types/branded.js';
import type { ComponentDefinitionIR } from '../src/types/ir.js';

const glob = (patterns: string[], allowEmpty = false): ComponentDefinitionIR => ({
  name: '',
  selector: { kind: 'glob', patterns },
  allowEmpty,
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
      [toComponentName('core')]: { name: '', selector: { kind: 'package' as const, packageNames: ['@x/core'] }, allowEmpty: false },
    };
    const workspace = new Map([['@x/core', toRepoRelativePath('packages/core/')]]);
    expect(classifyFile(toRepoRelativePath('packages/core/index.ts'), components, workspace)).toBe('core');
    expect(classifyFile(toRepoRelativePath('packages/other/index.ts'), components, workspace)).toBeUndefined();
  });
});

describe('validateComponents', () => {
  it('throws for a component whose selector matches zero files', () => {
    const components = { [toComponentName('empty')]: glob(['nowhere/**']) };
    expect(() => validateComponents(components, [toRepoRelativePath('a.ts')], new Map())).toThrow(ComponentValidationError);
  });

  it('does not throw when allowEmpty is set', () => {
    const components = { [toComponentName('empty')]: glob(['nowhere/**'], true) };
    expect(() => validateComponents(components, [toRepoRelativePath('a.ts')], new Map())).not.toThrow();
  });

  it('throws for a package selector naming a package absent from the workspace inventory', () => {
    const components = {
      [toComponentName('core')]: { name: '', selector: { kind: 'package' as const, packageNames: ['@x/missing'] }, allowEmpty: false },
    };
    expect(() => validateComponents(components, [toRepoRelativePath('a.ts')], new Map())).toThrow(ComponentValidationError);
  });
});

describe('validateClassifiedComponents', () => {
  it('does not throw when every component has at least one classified file', () => {
    const components = { [toComponentName('api')]: glob(['api/**']), [toComponentName('ui')]: glob(['ui/**']) };
    expect(() => validateClassifiedComponents(components, new Set(['api', 'ui']))).not.toThrow();
  });

  it('throws for a component with zero classified files, naming it, its selector, and the allowEmpty opt-out', () => {
    const components = { [toComponentName('api')]: glob(['api/**']), [toComponentName('ui')]: glob(['ui/**'])  };
    try {
      validateClassifiedComponents(components, new Set(['api']));
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ComponentValidationError);
      const e = err as ComponentValidationError;
      expect(e.componentName).toBe('ui');
      expect(e.message).toContain("'ui'");
      expect(e.message).toContain('ui/**');
      expect(e.message).toContain('allowEmpty');
      expect(e.message).toContain('first-match-wins');
    }
  });

  it('does not throw for a zero-classified-files component with allowEmpty: true', () => {
    const components = { [toComponentName('ui')]: glob(['ui/**'], true) };
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
