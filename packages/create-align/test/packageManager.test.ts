import { describe, expect, it } from 'vitest';
import { buildAddDevCommand, detectPackageManager, isWorkspaceRoot } from '../src/packageManager.js';

describe('detectPackageManager', () => {
  it('prefers the packageManager field over any lockfile', () => {
    const result = detectPackageManager({
      packageManagerField: 'pnpm@9.1.0',
      hasPnpmLock: false,
      hasYarnLock: true,
      hasPackageLock: true,
    });
    expect(result).toBe('pnpm');
  });

  it('recognizes yarn@ and npm@ prefixes in the packageManager field', () => {
    expect(detectPackageManager({ packageManagerField: 'yarn@4.1.0', hasPnpmLock: false, hasYarnLock: false, hasPackageLock: false })).toBe(
      'yarn',
    );
    expect(detectPackageManager({ packageManagerField: 'npm@10.2.0', hasPnpmLock: false, hasYarnLock: false, hasPackageLock: false })).toBe(
      'npm',
    );
  });

  it('ignores an unrecognized packageManager field and falls back to lockfile detection', () => {
    const result = detectPackageManager({
      packageManagerField: 'bun@1.0.0',
      hasPnpmLock: true,
      hasYarnLock: false,
      hasPackageLock: false,
    });
    expect(result).toBe('pnpm');
  });

  it('falls back to pnpm-lock.yaml when no packageManager field is present', () => {
    expect(detectPackageManager({ hasPnpmLock: true, hasYarnLock: true, hasPackageLock: true })).toBe('pnpm');
  });

  it('falls back to yarn.lock when pnpm-lock.yaml is absent', () => {
    expect(detectPackageManager({ hasPnpmLock: false, hasYarnLock: true, hasPackageLock: true })).toBe('yarn');
  });

  it('falls back to package-lock.json when neither pnpm nor yarn lockfiles are present', () => {
    expect(detectPackageManager({ hasPnpmLock: false, hasYarnLock: false, hasPackageLock: true })).toBe('npm');
  });

  it('defaults to npm when nothing is detected (a brand-new repo)', () => {
    expect(detectPackageManager({ hasPnpmLock: false, hasYarnLock: false, hasPackageLock: false })).toBe('npm');
  });
});

describe('buildAddDevCommand', () => {
  const specs = ['@spikedpunch/align-cli@0.1.1', '@spikedpunch/align-core@0.1.1'];

  it('builds pnpm add -D <specs>', () => {
    expect(buildAddDevCommand('pnpm', specs)).toEqual({ command: 'pnpm', args: ['add', '-D', ...specs] });
  });

  it('builds npm i -D <specs>', () => {
    expect(buildAddDevCommand('npm', specs)).toEqual({ command: 'npm', args: ['i', '-D', ...specs] });
  });

  it('builds yarn add -D <specs>', () => {
    expect(buildAddDevCommand('yarn', specs)).toEqual({ command: 'yarn', args: ['add', '-D', ...specs] });
  });

  it('throws when given no specs — nothing to install', () => {
    expect(() => buildAddDevCommand('npm', [])).toThrow(/at least one/);
  });

  it('adds pnpm -w at a workspace root (ERR_PNPM_ADDING_TO_ROOT otherwise)', () => {
    expect(buildAddDevCommand('pnpm', specs, { workspaceRoot: true })).toEqual({
      command: 'pnpm',
      args: ['add', '-D', '-w', ...specs],
    });
  });

  it('adds yarn -W at a workspace root (yarn classic workspace-root check)', () => {
    expect(buildAddDevCommand('yarn', specs, { workspaceRoot: true })).toEqual({
      command: 'yarn',
      args: ['add', '-D', '-W', ...specs],
    });
  });

  it('adds no workspace flag for npm even at a workspace root (npm adds to the root directly)', () => {
    expect(buildAddDevCommand('npm', specs, { workspaceRoot: true })).toEqual({
      command: 'npm',
      args: ['i', '-D', ...specs],
    });
  });
});

describe('isWorkspaceRoot', () => {
  it('uses pnpm-workspace.yaml presence for pnpm', () => {
    expect(isWorkspaceRoot('pnpm', { hasPnpmWorkspaceYaml: true, hasWorkspacesField: false })).toBe(true);
    expect(isWorkspaceRoot('pnpm', { hasPnpmWorkspaceYaml: false, hasWorkspacesField: true })).toBe(false);
  });

  it('uses the package.json workspaces field for npm and yarn', () => {
    expect(isWorkspaceRoot('yarn', { hasPnpmWorkspaceYaml: false, hasWorkspacesField: true })).toBe(true);
    expect(isWorkspaceRoot('npm', { hasPnpmWorkspaceYaml: true, hasWorkspacesField: false })).toBe(false);
  });
});
