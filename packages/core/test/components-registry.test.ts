import { describe, expect, it } from 'vitest';
import { classifyFile, ComponentValidationError, validateComponents } from '../src/components/registry.js';
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
