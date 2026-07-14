/**
 * The imperative shell (CODING_BEST_PRACTICES.md §14) that drives one `create-align` invocation:
 * guard (package.json must exist) -> detect package manager -> install pinned devDependencies ->
 * delegate to the local `align init`. All I/O goes through `CreateAlignEffects`; the only
 * branching logic (package-manager detection, add-dev command shape, version pinning) is pure and
 * imported from `packageManager.ts`/`versionPin.ts` — this file is deliberately thin sequencing,
 * testable end-to-end with a fake `CreateAlignEffects` (see `test/run.test.ts`), never mocking a
 * module.
 */
import { detectPackageManager, isWorkspaceRoot, type PackageManager } from './packageManager.js';
import { buildPinnedDevDependencySpecs } from './versionPin.js';
import type { CreateAlignEffects } from './effects.js';

export interface CreateAlignOptions {
  /** `--pm <pnpm|npm|yarn>` — overrides detection entirely when present. */
  readonly pmOverride?: PackageManager;
  /** Flags forwarded verbatim to `align init` (`--greenfield`, `--accept-existing`, `--yes`, ...). */
  readonly initArgs: readonly string[];
}

export type CreateAlignResult =
  | { readonly status: 'no-package-json' }
  | { readonly status: 'done'; readonly exitCode: number; readonly pm: PackageManager };

const NO_PACKAGE_JSON_MESSAGE =
  'No package.json found in the current directory. create-align augments an EXISTING repo — ' +
  'run `pnpm init` (or `npm init` / `yarn init`) first, then re-run this command.';

export async function runCreateAlign(effects: CreateAlignEffects, options: CreateAlignOptions): Promise<CreateAlignResult> {
  if (!effects.hasPackageJson()) {
    effects.log(NO_PACKAGE_JSON_MESSAGE);
    return { status: 'no-package-json' };
  }

  const packageManagerField = effects.readPackageManagerField();
  const pm =
    options.pmOverride ??
    detectPackageManager({
      ...(packageManagerField !== undefined ? { packageManagerField } : {}),
      ...effects.detectLockfiles(),
    });

  const workspaceRoot = isWorkspaceRoot(pm, effects.detectWorkspace());
  const specs = buildPinnedDevDependencySpecs(effects.ownVersion());
  effects.log(`Detected package manager: ${pm}${workspaceRoot ? ' (workspace root)' : ''}`);
  effects.log(`Installing ${specs.join(', ')} as devDependencies...`);
  await effects.installDevDeps(pm, specs, { workspaceRoot });

  effects.log('Running `align init`...');
  const exitCode = await effects.runAlignInit(options.initArgs);

  if (exitCode === 0) {
    effects.log('');
    effects.log('Done! Next steps:');
    effects.log('  align check      # run the architecture check');
    effects.log('  align doctor     # read-only advisory survey');
  } else {
    effects.log('');
    effects.log(`\`align init\` exited with code ${exitCode} — see its output above.`);
  }

  return { status: 'done', exitCode, pm };
}
