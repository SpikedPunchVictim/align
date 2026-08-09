// Project preparation — ADR 025 §4: "one mid-sized real OSS project, pinned to a specific commit,
// with node_modules installed in the image." This module owns the expensive, cacheable half
// (shallow-clone-at-pinned-sha + the project's OWN dependency install); lib/version-install.mjs
// owns the cheap, per-scenario half (installing align itself into an already-prepared copy).
import * as path from 'node:path';
import { run } from './exec.mjs';
import { ensureDir, exists, removeDir, cloneDir, writeJson } from './fs-utils.mjs';

function baseDir(cacheRoot, project) {
  return path.join(cacheRoot, 'base', `${project.id}-${project.sha}`);
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
