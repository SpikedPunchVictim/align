/**
 * One-off exploration: component-level dependency matrix + repo-wide cycle survey.
 * Feeds the SPIKE_REPORT's components-fit and violation-actionability sections.
 */

import { classifyFile } from './components.js';
import { KLUSTER_ROOT, SCAN_ROOTS } from './kluster-root.js';
import { evaluateRule } from './rules.js';
import { scanRepo } from './scanner.js';

const { graph } = scanRepo(KLUSTER_ROOT, SCAN_ROOTS);

const matrix = new Map<string, number>();
for (const edge of graph.edges) {
  const from = classifyFile(edge.from) ?? 'UNMAPPED';
  const to = classifyFile(edge.to) ?? 'UNMAPPED';
  if (from === to) continue;
  const key = `${from} -> ${to}`;
  matrix.set(key, (matrix.get(key) ?? 0) + 1);
}
console.log('=== Cross-component edges ===');
for (const [key, count] of [...matrix.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(count).padStart(5)}  ${key}`);
}

console.log('\n=== Repo-wide runtime-import cycles (survey, not a committed rule) ===');
const cycleViolations = evaluateRule(graph, {
  id: 'survey-no-cycles-repo',
  kind: 'no-cycles',
  scope: 'repo',
  edgeKinds: ['import', 'reexport', 'dynamic'],
  rationale: 'survey',
});
console.log(`cycles found: ${cycleViolations.length}`);
for (const v of cycleViolations.slice(0, 10)) {
  if (v.kind === 'no-cycles') console.log(`  [${v.chain.length - 1} files] ${v.chain.join(' -> ')}`);
}
