import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectComponents } from '../src/init/detect-components.js';

const tmpDirs: string[] = [];

/** Writes a repo tree; keys are repo-relative paths (parent dirs created as needed). */
function makeRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-detect-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

/** A workspace member package.json + one source file, the minimum `loadWorkspacePackages` needs. */
function pkg(name: string): Record<string, string> {
  return { [`packages/${name}/package.json`]: JSON.stringify({ name: `@x/${name}` }), [`packages/${name}/src/index.ts`]: 'export const x = 1;\n' };
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

describe('detectComponents — single-prefix workspace expands per-package (the "nest = 1 component" collapse)', () => {
  it('names each package individually instead of lumping a single `packages/*` prefix into one component', () => {
    const dir = makeRepo({
      'lerna.json': JSON.stringify({ packages: ['packages/*'] }),
      'package.json': JSON.stringify({ name: 'root' }),
      ...pkg('core'),
      ...pkg('common'),
      ...pkg('http'),
    });
    const components = detectComponents(dir);
    expect(components).toEqual([
      { name: 'common', pattern: 'packages/common/**' },
      { name: 'core', pattern: 'packages/core/**' },
      { name: 'http', pattern: 'packages/http/**' },
    ]);
  });

  it('camelCases a hyphenated package dir into a valid DSL identifier (packages/platform-express -> platformExpress)', () => {
    const dir = makeRepo({
      'lerna.json': JSON.stringify({ packages: ['packages/*'] }),
      'package.json': JSON.stringify({ name: 'root' }),
      ...pkg('core'),
      ...pkg('platform-express'),
    });
    expect(detectComponents(dir).map((c) => c.name).sort()).toEqual(['core', 'platformExpress']);
  });

  it('keeps the single lumped component when the workspace has too many packages to name individually', () => {
    const files: Record<string, string> = {
      'lerna.json': JSON.stringify({ packages: ['packages/*'] }),
      'package.json': JSON.stringify({ name: 'root' }),
    };
    for (let i = 0; i < 40; i++) Object.assign(files, pkg(`p${i}`));
    const dir = makeRepo(files);
    // Above the starter cap, an unreviewable 40-component config is worse than the coarse group.
    expect(detectComponents(dir)).toEqual([{ name: 'packages', pattern: 'packages/**' }]);
  });

  it('leaves a multi-prefix workspace prefix-grouped (backstage-shape: packages/* + plugins/*)', () => {
    const dir = makeRepo({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*', 'plugins/*'] }),
      'packages/core/package.json': JSON.stringify({ name: '@x/core' }),
      'packages/core/src/index.ts': 'export const x = 1;\n',
      'plugins/auth/package.json': JSON.stringify({ name: '@x/auth' }),
      'plugins/auth/src/index.ts': 'export const y = 1;\n',
    });
    // Two distinct prefixes -> the single-prefix expansion guard must not fire; stays coarse.
    expect(detectComponents(dir)).toEqual([
      { name: 'packages', pattern: 'packages/**' },
      { name: 'plugins', pattern: 'plugins/**' },
    ]);
  });
});
