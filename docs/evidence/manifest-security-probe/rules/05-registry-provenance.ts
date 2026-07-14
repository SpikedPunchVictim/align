// Rule 5: Registry provenance in lockfile.
// pnpm-lock.yaml's top-level `packages:` map omits a `tarball` field when a
// package resolves from the default registry (registry.npmjs.org is
// implied); a non-default resolution (a direct tarball URL, a git codeload
// URL, etc.) is recorded explicitly. This rule reports every package whose
// resolution carries an explicit tarball/URL, i.e. anything NOT resolved
// through the default registry.
import type { Finding, RepoTarget, RuleResult } from '../lib/types.ts';
import { readLockfile } from '../lib/read.ts';

export function run(target: RepoTarget): RuleResult {
  const start = performance.now();
  const findings: Finding[] = [];
  const notes: string[] = [];

  const lock = readLockfile(target.root);
  if (!lock?.packages) {
    notes.push('no pnpm-lock.yaml / packages section found');
    return { ruleId: 'registry-provenance', repo: target.id, wallTimeMs: performance.now() - start, count: 0, findings, notes };
  }

  let total = 0;
  for (const [key, entry] of Object.entries(lock.packages)) {
    total++;
    const tarball = entry.resolution?.tarball;
    if (tarball) {
      findings.push({
        repo: target.id,
        location: key,
        detail: `resolves via explicit URL, not the default registry: ${tarball}`,
        extra: { packageKey: key, tarball },
      });
    }
  }

  notes.push(`${total} total package entries scanned; ${findings.length} resolve outside the default registry`);

  return {
    ruleId: 'registry-provenance',
    repo: target.id,
    wallTimeMs: performance.now() - start,
    count: findings.length,
    findings,
    notes,
  };
}
