import { readBaselineSnapshot, writeBaseline } from '../src/align-dir.js';
import type { BaselineEntry } from '@spikedpunch/align-core';

/**
 * Writes a fixture baseline, for tests that need one to exist before the code under test runs.
 *
 * `writeBaseline` requires the token the caller read (ADR 030), because in production every write
 * is the tail of a read-modify-write and skipping the check is how a concurrent align loses a
 * consent decision. A fixture seed is the one case that genuinely is not: nothing was read, and
 * there is no other process. Rather than let ~65 test call sites each invent a token — and quietly
 * teach the next person that `undefined` is an acceptable thing to pass — the seed re-reads the
 * current state and writes against it, which is both correct and honest about what it is doing.
 *
 * Production code must NOT use this. The guard is the point there.
 */
export function seedBaseline(rootDir: string, entries: readonly BaselineEntry[]): void {
  writeBaseline(rootDir, entries, readBaselineSnapshot(rootDir).token);
}
