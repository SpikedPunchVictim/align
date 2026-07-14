import { vi } from 'vitest';
import type { CreateAlignEffects, DetectedLockfiles } from '../src/effects.js';
import type { PackageManager, WorkspaceFacts } from '../src/packageManager.js';

export interface FakeEffectsConfig {
  readonly hasPackageJson?: boolean;
  readonly packageManagerField?: string;
  readonly lockfiles?: DetectedLockfiles;
  readonly workspace?: WorkspaceFacts;
  readonly ownVersion?: string;
  readonly initExitCode?: number;
}

const DEFAULT_LOCKFILES: DetectedLockfiles = { hasPnpmLock: false, hasYarnLock: false, hasPackageLock: false };
const DEFAULT_WORKSPACE: WorkspaceFacts = { hasPnpmWorkspaceYaml: false, hasWorkspacesField: false };

/** A fully in-memory `CreateAlignEffects` fake — no real fs, no real network, no real child
 * process (CODING_BEST_PRACTICES.md §15: the test drives the state machine through the injected
 * seam, never module-mocks `node:child_process`). Every call is recorded in `calls` so tests can
 * assert both content and ORDER (install must happen before `align init`). */
export function createFakeEffects(config: FakeEffectsConfig = {}) {
  const calls: string[] = [];
  const installDevDeps = vi.fn(async (pm: PackageManager, specs: readonly string[], _options: { workspaceRoot: boolean }) => {
    calls.push(`install:${pm}:${specs.join(',')}`);
  });
  const runAlignInit = vi.fn(async (args: readonly string[]) => {
    calls.push(`init:${args.join(' ')}`);
    return config.initExitCode ?? 0;
  });
  const logs: string[] = [];

  const effects: CreateAlignEffects = {
    hasPackageJson: () => config.hasPackageJson ?? true,
    readPackageManagerField: () => config.packageManagerField,
    detectLockfiles: () => config.lockfiles ?? DEFAULT_LOCKFILES,
    detectWorkspace: () => config.workspace ?? DEFAULT_WORKSPACE,
    ownVersion: () => config.ownVersion ?? '0.1.0',
    installDevDeps,
    runAlignInit,
    log: (message: string) => {
      logs.push(message);
    },
  };

  return { effects, calls, logs, installDevDeps, runAlignInit };
}
