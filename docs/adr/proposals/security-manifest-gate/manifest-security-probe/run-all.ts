// Orchestrator for the manifest-security probe (Stage-S-shaped throwaway spike).
// Runs all 7 rules against align itself, kluster, and n8n; measures wall
// time per rule per repo; writes a JSON dump to out/ for the report to cite
// concrete numbers from, and prints a compact summary table to stdout.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RepoTarget, RuleResult } from './lib/types.ts';

import * as sourceHygiene from './rules/01-source-hygiene.ts';
import * as installScripts from './rules/02-install-scripts.ts';
import * as versionPinning from './rules/03-version-pinning.ts';
import * as lockfileDrift from './rules/04-lockfile-drift.ts';
import * as registryProvenance from './rules/05-registry-provenance.ts';
import * as depConfusion from './rules/06-dependency-confusion.ts';
import * as newDepBaseline from './rules/07-new-dep-baseline.ts';

const TARGETS: RepoTarget[] = [
  { id: 'align', root: '/Users/spikedpunchvictim/projects/align', gitUsable: true },
  { id: 'kluster', root: '/Users/spikedpunchvictim/projects/align/test-apps/kluster', gitUsable: false },
  { id: 'n8n', root: '/Users/spikedpunchvictim/projects/align/test-apps/n8n', gitUsable: false },
];

const RULES: Array<{ id: string; run: (t: RepoTarget) => RuleResult }> = [
  { id: 'source-hygiene', run: sourceHygiene.run },
  { id: 'install-scripts', run: installScripts.run },
  { id: 'version-pinning', run: versionPinning.run },
  { id: 'lockfile-drift', run: lockfileDrift.run },
  { id: 'registry-provenance', run: registryProvenance.run },
  { id: 'dependency-confusion-offline', run: depConfusion.run },
  { id: 'new-dep-baseline', run: newDepBaseline.run },
];

const results: RuleResult[] = [];

for (const target of TARGETS) {
  for (const rule of RULES) {
    const t0 = performance.now();
    const result = rule.run(target);
    const wall = performance.now() - t0;
    results.push(result);
    console.log(
      `${target.id.padEnd(8)} ${rule.id.padEnd(30)} count=${String(result.count).padEnd(6)} wall=${wall.toFixed(1)}ms`
    );
    if (result.notes.length) {
      for (const n of result.notes) console.log(`           note: ${n}`);
    }
  }
}

const outDir = '/Users/spikedpunchvictim/projects/align/spike/manifest-probe/out';
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
console.log(`\nWrote ${results.length} rule results to ${path.join(outDir, 'results.json')}`);
