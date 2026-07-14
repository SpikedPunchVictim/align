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

export interface ShellCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The devDependency-add invocation for each supported package manager, as an `execFile`-ready
 * `{ command, args }` pair — never a shell string (mirrors `@spikedpunch/align-agent`'s `git.ts`
 * discipline: build an argv array, let the imperative shell hand it to `execFile` untouched).
 */
export function buildAddDevCommand(pm: PackageManager, specs: readonly string[]): ShellCommand {
  if (specs.length === 0) throw new Error('buildAddDevCommand requires at least one dependency spec');
  switch (pm) {
    case 'pnpm':
      return { command: 'pnpm', args: ['add', '-D', ...specs] };
    case 'npm':
      return { command: 'npm', args: ['i', '-D', ...specs] };
    case 'yarn':
      return { command: 'yarn', args: ['add', '-D', ...specs] };
    default: {
      const exhaustive: never = pm;
      throw new Error(`unhandled package manager: ${String(exhaustive)}`);
    }
  }
}
