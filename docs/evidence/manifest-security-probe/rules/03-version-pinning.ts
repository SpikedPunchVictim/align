// Rule 3: Version-pinning policy.
// Classifies every importer dependency specifier as exact / caret / tilde /
// other-range / wildcard-or-latest / workspace-or-catalog (excluded from the
// "policy" question entirely — those aren't registry version pins).
import type { Finding, LockImporter, RepoTarget, RuleResult } from '../lib/types.ts';
import { readLockfile } from '../lib/read.ts';

type Bucket = 'exact' | 'caret' | 'tilde' | 'range' | 'wildcard-or-latest' | 'workspace-or-catalog' | 'non-registry';

function classify(specifier: string): Bucket {
  if (specifier.startsWith('workspace:') || specifier.startsWith('catalog:')) return 'workspace-or-catalog';
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|https?:\/\/|file:|link:)/.test(specifier)) return 'non-registry';
  if (specifier === '*' || specifier === 'latest' || specifier === 'x') return 'wildcard-or-latest';
  if (specifier.startsWith('^')) return 'caret';
  if (specifier.startsWith('~')) return 'tilde';
  if (/^\d+\.\d+\.\d+/.test(specifier)) return 'exact';
  return 'range'; // >=, <=, ||, x-ranges, etc.
}

export function run(target: RepoTarget): RuleResult {
  const start = performance.now();
  const findings: Finding[] = [];
  const notes: string[] = [];
  const counts: Record<Bucket, number> = {
    exact: 0,
    caret: 0,
    tilde: 0,
    range: 0,
    'wildcard-or-latest': 0,
    'workspace-or-catalog': 0,
    'non-registry': 0,
  };

  const lock = readLockfile(target.root);
  if (!lock?.importers) {
    notes.push('no pnpm-lock.yaml / importers section found');
    return { ruleId: 'version-pinning', repo: target.id, wallTimeMs: performance.now() - start, count: 0, findings, notes };
  }

  let total = 0;
  for (const [importerPath, importer] of Object.entries(lock.importers)) {
    const groups: Array<[string, LockImporter[keyof LockImporter] | undefined]> = [
      ['dependencies', importer.dependencies],
      ['devDependencies', importer.devDependencies],
      ['optionalDependencies', importer.optionalDependencies],
    ];
    for (const [groupName, deps] of groups) {
      if (!deps) continue;
      for (const [depName, dep] of Object.entries(deps)) {
        total++;
        const bucket = classify(dep.specifier);
        counts[bucket]++;
        if (bucket === 'wildcard-or-latest') {
          findings.push({
            repo: target.id,
            location: `${importerPath} (${groupName})`,
            detail: `${depName}: ${dep.specifier}`,
            extra: { depName, specifier: dep.specifier },
          });
        }
      }
    }
  }

  notes.push(
    `distribution over ${total} declared specifiers: exact=${counts.exact}, caret=${counts.caret}, tilde=${counts.tilde}, range=${counts.range}, wildcard/latest=${counts['wildcard-or-latest']}, workspace/catalog=${counts['workspace-or-catalog']} (excluded from policy question), non-registry=${counts['non-registry']} (see rule 1)`
  );

  return {
    ruleId: 'version-pinning',
    repo: target.id,
    wallTimeMs: performance.now() - start,
    count: findings.length, // count = only the sharpest signal (wildcard/latest); full distribution is in notes
    findings,
    notes,
  };
}
