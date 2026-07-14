/**
 * Injected effects — the imperative shell `run.ts`'s orchestration is built against, mirroring
 * `@spikedpunch/align-agent`'s `AgentEffects`/`GitEffects` split (CODING_BEST_PRACTICES.md §15:
 * "if you're reaching for module mocking, the dependency wasn't injected"). Every side effect
 * (reading the target repo's package.json/lockfiles, installing devDependencies, invoking the
 * freshly-installed local `align` binary) is an interface here so `runCreateAlign` can be driven
 * end-to-end by a fake in tests — no real install, no real network, no real child process.
 */
import type { PackageManager, WorkspaceFacts } from './packageManager.js';

export interface DetectedLockfiles {
  readonly hasPnpmLock: boolean;
  readonly hasYarnLock: boolean;
  readonly hasPackageLock: boolean;
}

export interface CreateAlignEffects {
  /** True iff the current working directory has an existing package.json — create-align only
   * augments an existing repo; scaffolding a brand-new one is out of scope (require the user to
   * `pnpm init` first). */
  readonly hasPackageJson: () => boolean;
  /** The target repo's own package.json `packageManager` field, if declared. */
  readonly readPackageManagerField: () => string | undefined;
  readonly detectLockfiles: () => DetectedLockfiles;
  /** Raw workspace-root markers for the pure `isWorkspaceRoot` decision: a `pnpm-workspace.yaml`
   * (pnpm) and a package.json `workspaces` field (npm/yarn). A workspace root needs an extra flag
   * on the add-dev command or pnpm/yarn refuse it. */
  readonly detectWorkspace: () => WorkspaceFacts;
  /** create-align's OWN version, read at runtime from its own package.json — never hardcoded, so
   * a release bump pins the matching align-cli/align-core release automatically. */
  readonly ownVersion: () => string;
  /** Installs `specs` as devDependencies via the detected/overridden package manager's add-dev
   * command — runs immediately, no confirmation prompt (that IS the point of this command).
   * `workspaceRoot` selects the workspace-root form of the command (pnpm `-w`, yarn `-W`). */
  readonly installDevDeps: (
    pm: PackageManager,
    specs: readonly string[],
    options: { readonly workspaceRoot: boolean },
  ) => Promise<void>;
  /** Invokes the freshly-installed LOCAL `align` binary's `init` subcommand with `args` forwarded
   * verbatim. Returns its exit code — create-align never reimplements init's file-writing. */
  readonly runAlignInit: (args: readonly string[]) => Promise<number>;
  readonly log: (message: string) => void;
}
