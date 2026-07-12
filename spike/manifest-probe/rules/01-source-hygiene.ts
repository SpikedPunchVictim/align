// Rule 1: Dependency source hygiene.
// git/http(s)/file/link dependency specifiers in the lockfile's resolved
// importer entries (catalog: refs resolve to their real specifier here,
// which raw package.json scanning would miss for catalog-managed deps).
import type { Finding, LockImporter, RepoTarget, RuleResult } from '../lib/types.ts';
import { readLockfile } from '../lib/read.ts';

const NON_REGISTRY_RE = /^(git\+|git:|github:|gitlab:|bitbucket:|https?:\/\/|file:|link:)/;

export function run(target: RepoTarget): RuleResult {
  const start = performance.now();
  const findings: Finding[] = [];
  const notes: string[] = [];

  const lock = readLockfile(target.root);
  if (!lock?.importers) {
    notes.push('no pnpm-lock.yaml / importers section found');
    return { ruleId: 'source-hygiene', repo: target.id, wallTimeMs: performance.now() - start, count: 0, findings, notes };
  }

  for (const [importerPath, importer] of Object.entries(lock.importers)) {
    const groups: Array<[string, LockImporter[keyof LockImporter] | undefined]> = [
      ['dependencies', importer.dependencies],
      ['devDependencies', importer.devDependencies],
      ['optionalDependencies', importer.optionalDependencies],
    ];
    for (const [groupName, deps] of groups) {
      if (!deps) continue;
      for (const [depName, dep] of Object.entries(deps)) {
        if (NON_REGISTRY_RE.test(dep.specifier)) {
          findings.push({
            repo: target.id,
            location: `${importerPath} (${groupName})`,
            detail: `${depName}: ${dep.specifier}`,
            extra: { depName, specifier: dep.specifier, group: groupName },
          });
        }
      }
    }
  }

  return {
    ruleId: 'source-hygiene',
    repo: target.id,
    wallTimeMs: performance.now() - start,
    count: findings.length,
    findings,
    notes,
  };
}
