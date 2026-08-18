// Rule 6: Dependency-confusion exposure (offline half only).
// Lists workspace-internal package names that are unscoped (no @scope/
// prefix) — these are claimable-by-name on the public npm registry, which is
// the precondition for a classic dependency-confusion attack (a public
// package published under the same name resolves instead of the intended
// internal one). The network half — is the name *actually* already claimed
// on the public registry today — is explicitly out of scope per the offline
// doctrine (§B.3.1 of docs/proposals/rule-expansion-evaluation.md): that
// answer requires a live registry query and is a different, network-gated
// rule class (an `align doctor`-style advisory at best, never this gate).
import type { Finding, RepoTarget, RuleResult } from '../lib/types.ts';
import { readLockfile, readPackageJson } from '../lib/read.ts';

export function run(target: RepoTarget): RuleResult {
  const start = performance.now();
  const findings: Finding[] = [];
  const notes: string[] = [];

  const lock = readLockfile(target.root);
  if (!lock?.importers) {
    notes.push('no pnpm-lock.yaml / importers section found');
    return { ruleId: 'dependency-confusion-offline', repo: target.id, wallTimeMs: performance.now() - start, count: 0, findings, notes };
  }

  let total = 0;
  for (const importerPath of Object.keys(lock.importers)) {
    const manifest = readPackageJson(target.root, importerPath);
    if (!manifest?.name) continue;
    total++;
    if (!manifest.name.startsWith('@')) {
      findings.push({
        repo: target.id,
        location: importerPath,
        detail: `unscoped workspace package name: ${manifest.name} (private: ${manifest.private === true})`,
        extra: { name: manifest.name, private: manifest.private === true },
      });
    }
  }

  notes.push(
    `${total} named workspace packages checked; offline half only — public-registry claim status NOT queried (zero network calls per probe constraints)`
  );

  return {
    ruleId: 'dependency-confusion-offline',
    repo: target.id,
    wallTimeMs: performance.now() - start,
    count: findings.length,
    findings,
    notes,
  };
}
