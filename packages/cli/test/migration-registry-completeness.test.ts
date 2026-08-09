import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIGRATION_REGISTRY, hasEntryForVersion, hasNotesForVersion } from '../src/migrations/registry.js';

// ADR 022: "A released version with no registry entry is a build failure, not an empty section."
// This is the enforcement mechanism — it reads packages/cli/package.json directly (not the
// in-process ALIGN_VERSION constant) so the check holds regardless of how that constant resolves,
// and fails CI the moment someone bumps the version without adding a matching registry entry.

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPackageJsonPath = path.join(here, '..', 'package.json');

function currentCliVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(cliPackageJsonPath, 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string') throw new Error(`${cliPackageJsonPath} has no string "version" field.`);
  return pkg.version;
}

describe('migration registry completeness (ADR 022)', () => {
  it('the current CLI version has a registry entry', () => {
    const version = currentCliVersion();
    expect(hasEntryForVersion(MIGRATION_REGISTRY, version)).toBe(true);
  });

  it('demonstrates the failure this guards against: a registry missing the current version fails the same check', () => {
    const version = currentCliVersion();
    const registryMissingCurrent = MIGRATION_REGISTRY.filter((entry) => entry.version !== version);
    // Sanity: the filter actually removed something, so this is a real "missing" case, not a no-op.
    expect(registryMissingCurrent.length).toBeLessThan(MIGRATION_REGISTRY.length);
    expect(hasEntryForVersion(registryMissingCurrent, version)).toBe(false);
  });

  it('hasEntryForVersion does not match on a version prefix or substring', () => {
    const registry = [{ version: '0.1.40', notes: [], validators: [], transforms: [] }];
    expect(hasEntryForVersion(registry, '0.1.4')).toBe(false);
  });

  // ADR 022, verbatim: a missing entry "would otherwise render as 'nothing to know about this
  // version,' which is the false-green shape — silence read as an all-clear." An entry that EXISTS
  // but carries zero notes is the same false-green shape one layer down: `align upgrade --notes`
  // would print nothing for a version that in fact changed something. `hasNotesForVersion` extends
  // the completeness discipline `hasEntryForVersion` established in slice B to catch it.
  it('the current CLI version\'s registry entry has at least one note (extends hasEntryForVersion to the notes tier)', () => {
    const version = currentCliVersion();
    expect(hasNotesForVersion(MIGRATION_REGISTRY, version)).toBe(true);
  });

  it('demonstrates the failure this guards against: an entry that exists but has zero notes fails the same check', () => {
    const version = currentCliVersion();
    const registryWithEmptyNotes = MIGRATION_REGISTRY.map((entry) =>
      entry.version === version ? { ...entry, notes: [] } : entry,
    );
    // Sanity: the entry still exists (hasEntryForVersion stays true) — only the notes predicate
    // should flip. This is what distinguishes "no entry" from "entry with no notes," per this
    // file's own doc comment on why the two checks are separate.
    expect(hasEntryForVersion(registryWithEmptyNotes, version)).toBe(true);
    expect(hasNotesForVersion(registryWithEmptyNotes, version)).toBe(false);
  });

  it('hasNotesForVersion is false for a version with no entry at all, not just an entry with empty notes', () => {
    expect(hasNotesForVersion(MIGRATION_REGISTRY, '9.9.9')).toBe(false);
  });
});
