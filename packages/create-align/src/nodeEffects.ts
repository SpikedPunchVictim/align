/**
 * Real filesystem/process implementation of `CreateAlignEffects` — the only place in
 * `@spikedpunch/create-align` that touches `node:child_process` (align's own dogfood rule
 * `custom.host:no-child-process-outside-git-rails` allowlists this file by path, the same way it
 * allowlists `@spikedpunch/align-agent`'s `git.ts`/`format.ts` — see the root `align.config.ts`).
 * Never a shell string built by hand — always an argv array handed to `execFile`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAddDevCommand, type PackageManager, type WorkspaceFacts } from './packageManager.js';
import { alignInitArgv } from './alignCli.js';
import type { CreateAlignEffects, DetectedLockfiles } from './effects.js';

const execFileAsync = promisify(execFile);

// Windows resolves a locally-installed bin through a generated `.cmd`/`.ps1` shim, which node's
// child_process can only execute through a shell (a plain execFile of a `.cmd` file fails outright
// on win32 — a well-known Node/npm-ecosystem limitation, not something `shell:false` can route
// around without a `cross-spawn`-style dependency, which the zero-runtime-dependency constraint
// here rules out). The command/args are always ours (a fixed package-manager name, or the local
// `align` bin path we just resolved) — never raw user/network input — so the reduced safety
// margin `shell:true` carries is bounded to that.
const execOptions = (cwd: string) => ({ cwd, shell: process.platform === 'win32', maxBuffer: 32 * 1024 * 1024 });

function readOwnPackageJson(): { readonly version: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/nodeEffects.js -> package.json is one level up from dist/, whether running from the
  // source repo (pre-publish) or from an installed node_modules/@spikedpunch/create-align/ tree —
  // package.json ships in the tarball regardless of the "files" allowlist.
  const pkgPath = path.join(here, '..', 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
}

function alignBinPath(cwd: string): string {
  const binName = process.platform === 'win32' ? 'align.cmd' : 'align';
  return path.join(cwd, 'node_modules', '.bin', binName);
}

export function createNodeEffects(cwd: string): CreateAlignEffects {
  return {
    hasPackageJson: (): boolean => fs.existsSync(path.join(cwd, 'package.json')),

    readPackageManagerField: (): string | undefined => {
      const pkgPath = path.join(cwd, 'package.json');
      if (!fs.existsSync(pkgPath)) return undefined;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { packageManager?: string };
      return pkg.packageManager;
    },

    detectLockfiles: (): DetectedLockfiles => ({
      hasPnpmLock: fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')),
      hasYarnLock: fs.existsSync(path.join(cwd, 'yarn.lock')),
      // bun.lock (text, current default) or bun.lockb (binary, older)
      hasBunLock: fs.existsSync(path.join(cwd, 'bun.lock')) || fs.existsSync(path.join(cwd, 'bun.lockb')),
      hasPackageLock: fs.existsSync(path.join(cwd, 'package-lock.json')),
    }),

    detectWorkspace: (): WorkspaceFacts => {
      const pkgPath = path.join(cwd, 'package.json');
      let hasWorkspacesField = false;
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown };
        hasWorkspacesField = pkg.workspaces !== undefined;
      }
      return {
        hasPnpmWorkspaceYaml: fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml')),
        hasWorkspacesField,
      };
    },

    ownVersion: (): string => readOwnPackageJson().version,

    installDevDeps: async (pm: PackageManager, specs: readonly string[], options: { workspaceRoot: boolean }): Promise<void> => {
      const { command, args } = buildAddDevCommand(pm, specs, { workspaceRoot: options.workspaceRoot });
      await execFileAsync(command, [...args], execOptions(cwd));
    },

    runAlignInit: async (args: readonly string[]): Promise<number> => {
      try {
        // The `init` subcommand is this effect's responsibility — `args` are only the forwarded
        // init flags (`--accept-existing`, `--greenfield`, ...), never the subcommand itself.
        const { stdout, stderr } = await execFileAsync(alignBinPath(cwd), [...alignInitArgv(args)], execOptions(cwd));
        if (stdout.length > 0) process.stdout.write(stdout);
        if (stderr.length > 0) process.stderr.write(stderr);
        return 0;
      } catch (err) {
        const failure = err as { code?: number; stdout?: string; stderr?: string };
        if (failure.stdout !== undefined && failure.stdout.length > 0) process.stdout.write(failure.stdout);
        if (failure.stderr !== undefined && failure.stderr.length > 0) process.stderr.write(failure.stderr);
        return typeof failure.code === 'number' ? failure.code : 1;
      }
    },

    log: (message: string): void => {
      console.log(message);
    },
  };
}
