/**
 * Measurement CLI: scan kluster, evaluate rules, write measured artifacts.
 *
 * Usage:
 *   pnpm scan                                  # full scan (packages/ application/ features/)
 *   pnpm scan -- --scope packages/kluster-bt/core   # single-subtree scan (dev verification)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFile, COMPONENTS } from './components.js';
import { KLUSTER_ROOT, SCAN_ROOTS } from './kluster-root.js';
import { evaluateRules, RULES } from './rules.js';
import { scanRepo } from './scanner.js';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');

function main(): void {
  const scopeIdx = process.argv.indexOf('--scope');
  const scopeArg = scopeIdx >= 0 ? process.argv[scopeIdx + 1] : undefined;
  const scanRoots = scopeArg !== undefined ? [scopeArg] : SCAN_ROOTS;

  console.log(`Scanning ${KLUSTER_ROOT} roots: ${scanRoots.join(', ')}`);
  const { graph, stats } = scanRepo(KLUSTER_ROOT, scanRoots);

  const ruleStarted = performance.now();
  const evaluations = evaluateRules(graph, RULES);
  const ruleWallTimeMs = performance.now() - ruleStarted;

  // Component fit: file counts per component + unmapped bucket.
  const componentFileCounts = new Map<string, number>(COMPONENTS.map((c) => [c.name, 0]));
  const unmappedFiles: string[] = [];
  for (const node of graph.nodes.keys()) {
    const component = classifyFile(node);
    if (component === undefined) {
      unmappedFiles.push(node);
    } else {
      componentFileCounts.set(component, (componentFileCounts.get(component) ?? 0) + 1);
    }
  }

  const uncertainByContext = new Map<string, number>();
  for (const u of graph.uncertain) {
    uncertainByContext.set(u.context, (uncertainByContext.get(u.context) ?? 0) + 1);
  }

  const statsReport = {
    scanRoots,
    stats,
    ruleWallTimeMs: Math.round(ruleWallTimeMs * 10) / 10,
    violationCountsPerRule: evaluations.map((e) => ({ ruleId: e.rule.id, count: e.violations.length })),
    componentFileCounts: Object.fromEntries(componentFileCounts),
    unmappedFileCount: unmappedFiles.length,
    unmappedFilesSample: unmappedFiles.slice(0, 25),
    uncertainByContext: Object.fromEntries(uncertainByContext),
    uncertainSample: graph.uncertain.slice(0, 40),
    externalPackagesSample: [...graph.externalPackages].sort().slice(0, 40),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'graph-stats.json'), JSON.stringify(statsReport, null, 2));
  fs.writeFileSync(
    path.join(OUT_DIR, 'violations.json'),
    JSON.stringify(
      evaluations.map((e) => ({ ruleId: e.rule.id, kind: e.rule.kind, violations: e.violations })),
      null,
      2,
    ),
  );

  console.log('\n=== SCAN STATS ===');
  console.log(JSON.stringify({ ...stats }, null, 2));
  console.log(`Rule evaluation: ${statsReport.ruleWallTimeMs} ms`);
  console.log('Violations per rule:');
  for (const { ruleId, count } of statsReport.violationCountsPerRule) console.log(`  ${ruleId}: ${count}`);
  console.log(`Unmapped files: ${unmappedFiles.length}`);
  console.log(`Uncertain edges: ${graph.uncertain.length} (files affected: ${stats.uncertainFileCount})`);
  console.log(`Artifacts written to ${OUT_DIR}`);
}

main();
