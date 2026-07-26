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

describe('detectComponents — top-level source dirs with no package.json (the "vscode = 6,234 unmapped" collapse)', () => {
  it('maps a top-level source dir (src/) that has no package.json, alongside the package dirs', () => {
    const dir = makeRepo({
      'package.json': JSON.stringify({ name: 'vscode' }), // no `workspaces` — not a JS monorepo
      'build/package.json': JSON.stringify({ name: 'build-tooling' }),
      'build/gulpfile.ts': 'export const x = 1;\n',
      'src/main.ts': 'export const m = 1;\n', // src/ has direct source but NO package.json
      'src/vs/base/common/uri.ts': 'export const u = 1;\n',
      'resources/icon.svg': '<svg/>\n', // no source -> not a component
    });
    const names = detectComponents(dir).map((c) => c.name).sort();
    expect(names).toEqual(['build', 'src']); // src/ is now bound instead of left unmapped
    expect(detectComponents(dir).find((c) => c.name === 'src')?.pattern).toBe('src/**');
  });

  it('detects a top-level dir whose source lives only under its own src/ subdir (no package.json at its root)', () => {
    const dir = makeRepo({
      'package.json': JSON.stringify({ name: 'app' }),
      'tools/package.json': JSON.stringify({ name: 'tools' }),
      'tools/index.ts': 'export const t = 1;\n',
      'server/src/index.ts': 'export const s = 1;\n', // server/ has no package.json, source under src/
    });
    expect(detectComponents(dir).map((c) => c.name).sort()).toEqual(['server', 'tools']);
  });

  it('does not turn a build-output dir (dist/, out/) with loose .js into a component', () => {
    const dir = makeRepo({
      'package.json': JSON.stringify({ name: 'app' }),
      'pkg/package.json': JSON.stringify({ name: 'pkg' }),
      'pkg/index.ts': 'export const p = 1;\n',
      'dist/bundle.js': 'module.exports = {};\n', // build output, no package.json -> skipped
      'out/main.js': 'module.exports = {};\n',
    });
    expect(detectComponents(dir).map((c) => c.name).sort()).toEqual(['pkg']);
  });

  it('preserves the single-package `app` default when there are NO top-level package dirs (source-augment only fires alongside packages)', () => {
    const dir = makeRepo({
      'package.json': JSON.stringify({ name: 'app' }), // no workspaces, no sub-package dirs
      'src/index.ts': 'export const a = 1;\n',
    });
    // No top-level package dir -> the source-dir augmentation must NOT fire and rename `app` to `src`.
    expect(detectComponents(dir)).toEqual([{ name: 'app', pattern: 'src/**' }]);
  });
});
