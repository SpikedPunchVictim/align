// Rule 4: Lockfile <-> manifest drift.
// For each workspace member, compares package.json's declared dependency
// names against the lockfile importer's recorded set for the same path.
// Pure offline consistency check — no install required.
//
// CORRECTED after a hand-verified false-positive pass (see report): the
// first version compared only dependencies/devDependencies/
// optionalDependencies and produced a 100%-false-positive result on n8n (3/3
// findings) — every one was a `peerDependency` that pnpm's
// `auto-install-peers = true` (n8n's .npmrc) auto-installs into the
// lockfile's importer entry even though it never appears in package.json's
// non-peer dependency fields. peerDependencies must be included on the
// manifest side (regardless of `optional` in peerDependenciesMeta — the
// observed false positive, `pg-native`, was itself marked optional and still
// got auto-installed) or this rule is pure noise on any repo with that
// pnpm setting enabled.
import type { Finding, LockImporter, RepoTarget, RuleResult } from '../lib/types.ts';
import { readLockfile, readPackageJson } from '../lib/read.ts';

function depNames(deps: Record<string, string> | undefined): Set<string> {
  return new Set(Object.keys(deps ?? {}));
}

function lockDepNames(importer: LockImporter): Set<string> {
  const names = new Set<string>();
  for (const group of [importer.dependencies, importer.devDependencies, importer.optionalDependencies]) {
    if (!group) continue;
    for (const name of Object.keys(group)) names.add(name);
  }
  return names;
}

export function run(target: RepoTarget): RuleResult {
  const start = performance.now();
  const findings: Finding[] = [];
  const notes: string[] = [];

  const lock = readLockfile(target.root);
  if (!lock?.importers) {
    notes.push('no pnpm-lock.yaml / importers section found');
    return { ruleId: 'lockfile-drift', repo: target.id, wallTimeMs: performance.now() - start, count: 0, findings, notes };
  }

  let checkedImporters = 0;
  for (const [importerPath, importer] of Object.entries(lock.importers)) {
    const manifest = readPackageJson(target.root, importerPath);
    if (!manifest) {
      findings.push({
        repo: target.id,
        location: importerPath,
        detail: 'importer present in lockfile but package.json not found at that path',
      });
      continue;
    }
    checkedImporters++;

    const manifestDeps = new Set([
      ...depNames(manifest.dependencies),
      ...depNames(manifest.devDependencies),
      ...depNames(manifest.optionalDependencies),
      ...depNames(manifest.peerDependencies), // see file header: auto-install-peers false-positive fix
    ]);
    const lockDeps = lockDepNames(importer);

    for (const name of manifestDeps) {
      if (!lockDeps.has(name)) {
        findings.push({
          repo: target.id,
          location: importerPath,
          detail: `declared in package.json but absent from lockfile: ${name}`,
          extra: { depName: name, direction: 'manifest-only' },
        });
      }
    }
    for (const name of lockDeps) {
      if (!manifestDeps.has(name)) {
        findings.push({
          repo: target.id,
          location: importerPath,
          detail: `present in lockfile but absent from package.json: ${name}`,
          extra: { depName: name, direction: 'lockfile-only' },
        });
      }
    }
  }

  notes.push(`checked ${checkedImporters} workspace members against their lockfile importer entries`);

  return {
    ruleId: 'lockfile-drift',
    repo: target.id,
    wallTimeMs: performance.now() - start,
    count: findings.length,
    findings,
    notes,
  };
}
