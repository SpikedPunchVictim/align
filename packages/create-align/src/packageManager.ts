/**
 * Functional core (CODING_BEST_PRACTICES.md §14): package-manager detection and the resulting
 * devDependency-add invocation are both pure, data-in/data-out functions — no fs, no
 * child_process, fully unit-testable with plain objects. `nodeEffects.ts` is the only place that
 * gathers the real inputs (reading package.json, statting lockfiles) and executes the resulting
 * command.
 */

export type PackageManager = 'pnpm' | 'npm' | 'yarn';

export interface DetectPackageManagerInput {
  /** The `packageManager` field from the target repo's package.json, e.g. `"pnpm@9.1.0"` —
   * verbatim, unparsed beyond the prefix check below. */
  readonly packageManagerField?: string;
  readonly hasPnpmLock: boolean;
  readonly hasYarnLock: boolean;
  readonly hasPackageLock: boolean;
}

const FIELD_PREFIXES: ReadonlyArray<readonly [prefix: string, pm: PackageManager]> = [
  ['pnpm@', 'pnpm'],
  ['yarn@', 'yarn'],
  ['npm@', 'npm'],
];

/**
 * Detects which package manager to use, in order: the `packageManager` field (Corepack's own
 * source of truth) first, then lockfile presence (pnpm-lock.yaml -> yarn.lock -> package-lock.json),
 * defaulting to npm when nothing is present (a brand-new repo with no lockfile yet).
 */
export function detectPackageManager(input: DetectPackageManagerInput): PackageManager {
  if (input.packageManagerField !== undefined) {
    for (const [prefix, pm] of FIELD_PREFIXES) {
      if (input.packageManagerField.startsWith(prefix)) return pm;
    }
  }
  if (input.hasPnpmLock) return 'pnpm';
  if (input.hasYarnLock) return 'yarn';
  if (input.hasPackageLock) return 'npm';
  return 'npm';
}

export interface WorkspaceFacts {
  /** A `pnpm-workspace.yaml` exists in the target directory — pnpm's workspace-root marker. */
  readonly hasPnpmWorkspaceYaml: boolean;
  /** The target package.json declares a `workspaces` field — npm/yarn's workspace-root marker. */
  readonly hasWorkspacesField: boolean;
}

/**
 * Whether the target directory is a package-manager WORKSPACE ROOT. This changes the add-dev
 * invocation: pnpm refuses `pnpm add` at a workspace root without `-w` (`ERR_PNPM_ADDING_TO_ROOT`),
 * and yarn classic has the same guard (`-W`). pnpm marks a workspace with `pnpm-workspace.yaml`;
 * npm/yarn mark it with a `workspaces` field in package.json.
 */
export function isWorkspaceRoot(pm: PackageManager, facts: WorkspaceFacts): boolean {
  return pm === 'pnpm' ? facts.hasPnpmWorkspaceYaml : facts.hasWorkspacesField;
}

export interface ShellCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface AddDevCommandOptions {
  /** True when the target cwd is the package-manager workspace root — adds the flag pnpm/yarn
   * require to add a dependency there. For a monorepo this IS what we want: `align init` writes
   * `align.config.ts` at the repo root, which resolves `@spikedpunch/align-core` from the root's
   * `node_modules`. */
  readonly workspaceRoot?: boolean;
}

/**
 * The devDependency-add invocation for each supported package manager, as an `execFile`-ready
 * `{ command, args }` pair — never a shell string (mirrors `@spikedpunch/align-agent`'s `git.ts`
 * discipline: build an argv array, let the imperative shell hand it to `execFile` untouched).
 */
export function buildAddDevCommand(
  pm: PackageManager,
  specs: readonly string[],
  options: AddDevCommandOptions = {},
): ShellCommand {
  if (specs.length === 0) throw new Error('buildAddDevCommand requires at least one dependency spec');
  const root = options.workspaceRoot === true;
  switch (pm) {
    case 'pnpm':
      // `-w`/`--workspace-root` — pnpm errors with ERR_PNPM_ADDING_TO_ROOT at a workspace root otherwise.
      return { command: 'pnpm', args: ['add', '-D', ...(root ? ['-w'] : []), ...specs] };
    case 'npm':
      // npm adds to the root package.json without a workspace flag.
      return { command: 'npm', args: ['i', '-D', ...specs] };
    case 'yarn':
      // yarn CLASSIC (v1) needs `-W` at a workspace root; yarn berry (v2+) neither needs nor accepts
      // it — yarn support is best-effort (see packages/create-align/README.md).
      return { command: 'yarn', args: ['add', '-D', ...(root ? ['-W'] : []), ...specs] };
    default: {
      const exhaustive: never = pm;
      throw new Error(`unhandled package manager: ${String(exhaustive)}`);
    }
  }
}
