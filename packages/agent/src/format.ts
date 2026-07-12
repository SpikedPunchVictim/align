/**
 * Mechanical post-format (APPLY step, IMPLEMENTATION_PLAN.md Stage 4): if the TARGET repo being
 * fixed exposes prettier, run it on touched files before committing; skip silently otherwise.
 * This is a target-repo runtime detection, not align's own repo's tooling — align's own repo has
 * no prettier config (confirmed at Stage-4 research time), so this must never assume prettier is
 * present.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function prettierBinaryPath(rootDir: string): string | undefined {
  const binPath = path.join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'prettier.cmd' : 'prettier');
  return fs.existsSync(binPath) ? binPath : undefined;
}

function targetRepoDeclaresPrettier(rootDir: string): boolean {
  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.prettier ?? pkg.devDependencies?.prettier);
  } catch {
    return false;
  }
}

/** Runs the target repo's own prettier binary on `paths` (relative to `rootDir`) if — and only if
 * — the repo both declares prettier as a dependency AND has it installed locally. Never throws:
 * a formatting failure is not fixable by the agent and must not halt the loop. */
export async function formatIfAvailable(rootDir: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  if (!targetRepoDeclaresPrettier(rootDir)) return;
  const bin = prettierBinaryPath(rootDir);
  if (bin === undefined) return;
  try {
    await execFileAsync(bin, ['--write', ...paths], { cwd: rootDir });
  } catch {
    // Mechanical formatting is best-effort; a prettier crash must not halt the fix loop.
  }
}
