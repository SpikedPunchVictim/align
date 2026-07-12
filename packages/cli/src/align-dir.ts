/**
 * Imperative shell around `@align/core`'s pure `BaselineStore` (CODING_BEST_PRACTICES.md §15/16:
 * functional core, imperative shell) — all filesystem I/O for `.align/` lives here, not in core.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BaselineEntry } from '@align/core';

export const ALIGN_DIR = '.align';
const BASELINE_FILENAME = 'baseline.json';

export function alignDirPath(rootDir: string): string {
  return path.join(rootDir, ALIGN_DIR);
}

function baselinePath(rootDir: string): string {
  return path.join(alignDirPath(rootDir), BASELINE_FILENAME);
}

export function ensureAlignDir(rootDir: string): void {
  fs.mkdirSync(alignDirPath(rootDir), { recursive: true });
}

export function readBaseline(rootDir: string): BaselineEntry[] {
  const file = baselinePath(rootDir);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as BaselineEntry[]) : [];
  } catch {
    return [];
  }
}

export function writeBaseline(rootDir: string, entries: readonly BaselineEntry[]): void {
  ensureAlignDir(rootDir);
  const sorted = [...entries].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  fs.writeFileSync(baselinePath(rootDir), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}
