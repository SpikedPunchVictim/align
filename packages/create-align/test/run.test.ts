import { describe, expect, it } from 'vitest';
import { runCreateAlign } from '../src/run.js';
import { createFakeEffects } from './fakeEffects.js';

describe('runCreateAlign', () => {
  it('refuses when no package.json exists — never installs, never runs align init', async () => {
    const { effects, installDevDeps, runAlignInit, logs } = createFakeEffects({ hasPackageJson: false });
    const result = await runCreateAlign(effects, { initArgs: [] });
    expect(result).toEqual({ status: 'no-package-json' });
    expect(installDevDeps).not.toHaveBeenCalled();
    expect(runAlignInit).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/pnpm init/);
  });

  it('installs pinned devDependencies via the detected package manager, THEN runs align init, in order', async () => {
    const { effects, calls } = createFakeEffects({ lockfiles: { hasPnpmLock: true, hasYarnLock: false, hasPackageLock: false }, ownVersion: '0.1.1' });
    const result = await runCreateAlign(effects, { initArgs: [] });
    expect(result).toEqual({ status: 'done', exitCode: 0, pm: 'pnpm' });
    expect(calls).toEqual(['install:pnpm:@spikedpunch/align-cli@0.1.1,@spikedpunch/align-core@0.1.1', 'init:']);
  });

  it('respects an explicit --pm override even when a different lockfile is present', async () => {
    const { effects, calls } = createFakeEffects({ lockfiles: { hasPnpmLock: true, hasYarnLock: false, hasPackageLock: false } });
    const result = await runCreateAlign(effects, { pmOverride: 'npm', initArgs: [] });
    expect(result.status).toBe('done');
    expect(result.status === 'done' && result.pm).toBe('npm');
    expect(calls[0]).toMatch(/^install:npm:/);
  });

  it('forwards init flags verbatim to align init, unmodified', async () => {
    const { effects, runAlignInit } = createFakeEffects({});
    await runCreateAlign(effects, { initArgs: ['--greenfield', '--accept-existing'] });
    expect(runAlignInit).toHaveBeenCalledWith(['--greenfield', '--accept-existing']);
  });

  it('detects packageManager field over lockfile presence', async () => {
    const { effects, calls } = createFakeEffects({
      packageManagerField: 'yarn@4.1.0',
      lockfiles: { hasPnpmLock: true, hasYarnLock: false, hasPackageLock: false },
    });
    await runCreateAlign(effects, { initArgs: [] });
    expect(calls[0]).toMatch(/^install:yarn:/);
  });

  it('propagates a non-zero align init exit code without throwing', async () => {
    const { effects } = createFakeEffects({ initExitCode: 1 });
    const result = await runCreateAlign(effects, { initArgs: [] });
    expect(result).toEqual({ status: 'done', exitCode: 1, pm: 'npm' });
  });
});
