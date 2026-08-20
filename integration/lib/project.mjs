// Project preparation — ADR 025 §4: "one mid-sized real OSS project, pinned to a specific commit,
// with node_modules installed in the image." This module owns the expensive, cacheable half
// (shallow-clone-at-pinned-sha + the project's OWN dependency install); lib/version-install.mjs
// owns the cheap, per-scenario half (installing align itself into an already-prepared copy).
import * as path from 'node:path';
import { run } from './exec.mjs';
import { ensureDir, exists, removeDir, cloneDir, writeJson, sha256String } from './fs-utils.mjs';

/**
 * F11: the base-cache key must capture everything that affects the INSTALLED dependency state of
 * the cached checkout, not just which project/commit it is. The original key was `<id>-<sha>`
 * only — `project.installCmd` (e.g. adding/removing `--legacy-peer-deps`), the npm version, and
 * the node version can all change what a `npm ci`/`npm install` in that directory actually
 * produces, and none of them are reflected in the pinned commit's sha. Bump nest's install flags
 * without touching `sha` and a warm cache would silently keep serving the OLD dependency tree —
 * exactly the "dependency state is accidental" failure mode ADR 025 §4 says the container exists
 * to prevent, reintroduced at the cache layer.
 */
function installFingerprint(project) {
  const npmVersion = run('npm', ['--version']).stdout.trim();
  const installCmdStr = `${project.installCmd.command} ${project.installCmd.args.join(' ')}`;
  // `buildCmd` joins the key for exactly the reason F11 gave for `installCmd` (LEDGER D060):
  // adding or changing a build step changes what the cached checkout CONTAINS — the presence of
  // `dist/` is the single property that separates a corpus which can reproduce D052 from one that
  // cannot. Omitting it would let a warm cache keep serving an UNBUILT tree after a project gained
  // a build step, which is the same silent-stale-cache failure F11 exists to prevent.
  const buildCmdStr = project.buildCmd === undefined ? '' : `${project.buildCmd.command} ${project.buildCmd.args.join(' ')}`;
  return sha256String(JSON.stringify({ installCmdStr, buildCmdStr, nodeVersion: process.version, npmVersion })).slice(0, 12);
}

function baseDir(cacheRoot, project) {
  return path.join(cacheRoot, 'base', `${project.id}-${project.sha}-${installFingerprint(project)}`);
}

function markerPath(dir) {
  return path.join(dir, '.integration-base-ready.json');
}

/**
 * Ensures a fully-cloned-and-installed base checkout of `project` exists under
 * `<cacheRoot>/base/<id>-<sha>/`, and returns its path. Idempotent: a second call with the same
 * project/cacheRoot is a no-op (checked via a marker file written only after both the clone and
 * the install succeed, so a run killed mid-install never leaves a corrupt "ready" base behind for
 * the next invocation to trust).
 *
 * Fetches the exact pinned commit rather than cloning the branch tip — `git fetch --depth 1
 * origin <sha>` (GitHub's smart-HTTP server allows fetching by exact commit SHA even when it
 * isn't currently a ref tip) — so the harness stays pinned regardless of how far the project's
 * default branch has moved since. Falls back to a full clone + checkout if the shallow-by-sha
 * fetch is rejected (older git servers, or a host that disables reachable-SHA1-in-want).
 */
export function prepareProjectBase(project, cacheRoot, log = () => {}) {
  const dir = baseDir(cacheRoot, project);
  const marker = markerPath(dir);
  if (exists(marker)) {
    log(`[project] base cache hit: ${dir}`);
    return dir;
  }

  removeDir(dir);
  ensureDir(dir);

  log(`[project] cloning ${project.repoUrl} @ ${project.sha} (shallow, by-sha)`);
  let r = run('git', ['init', '--quiet'], { cwd: dir });
  if (r.exitCode !== 0) throw new Error(`git init failed:\n${r.stderr}`);
  r = run('git', ['remote', 'add', 'origin', project.repoUrl], { cwd: dir });
  if (r.exitCode !== 0) throw new Error(`git remote add failed:\n${r.stderr}`);

  r = run('git', ['fetch', '--depth', '1', 'origin', project.sha], { cwd: dir, timeoutMs: 5 * 60 * 1000 });
  if (r.exitCode === 0) {
    r = run('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: dir });
    if (r.exitCode !== 0) throw new Error(`git checkout FETCH_HEAD failed:\n${r.stderr}`);
  } else {
    log('[project] shallow fetch-by-sha failed, falling back to full clone + checkout');
    removeDir(dir);
    ensureDir(path.dirname(dir));
    r = run('git', ['clone', '--quiet', project.repoUrl, dir], { timeoutMs: 10 * 60 * 1000 });
    if (r.exitCode !== 0) throw new Error(`git clone failed:\n${r.stderr}`);
    r = run('git', ['checkout', '--quiet', project.sha], { cwd: dir });
    if (r.exitCode !== 0) throw new Error(`git checkout ${project.sha} failed:\n${r.stderr}`);
  }

  const head = run('git', ['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();
  if (head !== project.sha) {
    throw new Error(`checked out HEAD (${head}) does not match pinned sha (${project.sha})`);
  }

  log(`[project] installing dependencies: ${project.installCmd.command} ${project.installCmd.args.join(' ')}`);
  const install = run(project.installCmd.command, project.installCmd.args, { cwd: dir, timeoutMs: 15 * 60 * 1000 });
  if (install.exitCode !== 0) {
    throw new Error(
      `${project.installCmd.command} ${project.installCmd.args.join(' ')} failed (exit ${install.exitCode}):\n${install.stderr.slice(-4000)}`,
    );
  }

  // OPTIONAL build step (LEDGER D060). Without it the corpus is structurally incapable of holding
  // the shape D052 lived in: a workspace whose packages are BUILT, so `main` points at a real
  // `dist/`, so `ts.resolveModuleName` succeeds and lands outside the scan. Measured 2026-08-20 on
  // the nest base — 0 built dist directories, 0 workspace symlinks — which is why 28/28 green said
  // nothing about that class. A project that declares no `buildCmd` behaves exactly as before.
  if (project.buildCmd !== undefined) {
    log(`[project] building: ${project.buildCmd.command} ${project.buildCmd.args.join(' ')}`);
    const build = run(project.buildCmd.command, project.buildCmd.args, { cwd: dir, timeoutMs: 30 * 60 * 1000 });
    if (build.exitCode !== 0) {
      throw new Error(
        `${project.buildCmd.command} ${project.buildCmd.args.join(' ')} failed (exit ${build.exitCode}):\n${build.stderr.slice(-4000)}`,
      );
    }
  }

  writeJson(marker, { sha: head, readyAt: new Date().toISOString() });
  log(`[project] base ready: ${dir}`);
  return dir;
}

/** Materializes a fresh, disposable working copy of a prepared base into `destDir` (CoW clone —
 * see fs-utils.mjs's cloneDir doc comment for why this needs to be fast). */
export function materializeWorkingCopy(basePath, destDir) {
  removeDir(destDir);
  cloneDir(basePath, destDir);
}
