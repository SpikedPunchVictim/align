// Filesystem helpers for the integration harness. Node-only (`node:fs`, `node:child_process`,
// `node:crypto`) — no runtime dependency, per ADR 025 §"Node ESM, zero new runtime dependencies".
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(p) {
  return fs.existsSync(p);
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Duplicates `src` into `dst` (`dst` must not already exist). Prefers a copy-on-write clone —
 * `cp -Rc` on macOS/APFS, `cp -R --reflink=auto` on Linux (btrfs/xfs) — because the harness clones
 * a fully `npm ci`'d project tree (hundreds of MB of `node_modules`) once per scenario execution;
 * a CoW clone is near-instant regardless of tree size, where a byte copy would dominate the
 * harness's wall-clock time. Falls back to a plain recursive copy when the CoW flag is rejected
 * (non-APFS macOS volume, non-CoW Linux filesystem, or inside some container overlay filesystems)
 * — correctness never depends on the fast path succeeding.
 */
export function cloneDir(src, dst) {
  ensureDir(path.dirname(dst));
  if (process.platform === 'darwin') {
    const r = spawnSync('cp', ['-Rc', src, dst], { stdio: 'pipe' });
    if (r.status === 0) return;
  } else {
    const r = spawnSync('cp', ['-R', '--reflink=auto', src, dst], { stdio: 'pipe' });
    if (r.status === 0) return;
  }
  // Fallback: plain recursive copy (still correct, just slower).
  fs.cpSync(src, dst, { recursive: true });
}

export function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256String(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readTextOrUndefined(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  return fs.readFileSync(filePath, 'utf8');
}

export function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}
