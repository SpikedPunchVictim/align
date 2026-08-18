/**
 * Probe 5 — three spike extensions over one shared scan:
 *  (a) type-only cycle noise: cycles with vs without type-only edges;
 *  (b) inferred starter rules: component pairs with zero edges = candidate no-dependency rules;
 *  (c) payload compaction: structured-only compact JSON vs the spike's prose payload.
 */

import { classifyFile, COMPONENTS } from './components.js';
import { KLUSTER_ROOT, SCAN_ROOTS } from './kluster-root.js';
import { evaluateRule, evaluateRules, RULES, type Violation } from './rules.js';
import { scanRepo } from './scanner.js';

const { graph } = scanRepo(KLUSTER_ROOT, SCAN_ROOTS);

// ---------- (a) type-only cycle noise ----------
console.log('=== (a) type-only cycle noise ===');
const runtimeCycles = evaluateRule(graph, {
  id: 'probe-cycles-runtime',
  kind: 'no-cycles',
  scope: 'repo',
  edgeKinds: ['import', 'reexport', 'dynamic'],
  rationale: 'probe',
});
const allKindCycles = evaluateRule(graph, {
  id: 'probe-cycles-all-kinds',
  kind: 'no-cycles',
  scope: 'repo',
  edgeKinds: ['import', 'reexport', 'dynamic', 'type-only'],
  rationale: 'probe',
});
console.log(`runtime-edge cycles: ${runtimeCycles.length}`);
console.log(`cycles with type-only edges included: ${allKindCycles.length}`);
for (const v of allKindCycles) {
  if (v.kind === 'no-cycles') console.log(`  [${v.chain.length - 1} hops] ${v.chain.join(' -> ')}`);
}

// ---------- (b) inferred starter rules ----------
console.log('\n=== (b) inferred starter rules (zero-edge component pairs) ===');
const pairEdgeCounts = new Map<string, number>();
for (const edge of graph.edges) {
  const from = classifyFile(edge.from);
  const to = classifyFile(edge.to);
  if (from === undefined || to === undefined || from === to) continue;
  pairEdgeCounts.set(`${from} -> ${to}`, (pairEdgeCounts.get(`${from} -> ${to}`) ?? 0) + 1);
}
const names = COMPONENTS.map((c) => c.name);
const candidates: string[] = [];
const nonCandidates: string[] = [];
for (const from of names) {
  for (const to of names) {
    if (from === to) continue;
    const key = `${from} -> ${to}`;
    const count = pairEdgeCounts.get(key) ?? 0;
    if (count === 0) candidates.push(key);
    else nonCandidates.push(`${key} (${count} edges)`);
  }
}
console.log(`ordered component pairs: ${names.length * (names.length - 1)}`);
console.log(`candidate no-dependency rules (zero edges today): ${candidates.length}`);
console.log(`pairs with existing edges (NOT candidates): ${nonCandidates.length}`);
for (const line of nonCandidates.sort()) console.log(`  ${line}`);
console.log('NOTE: api-app -> ui-app currently has 1 edge — the deliberate spike probe import.');

// ---------- (c) payload compaction ----------
console.log('\n=== (c) payload compaction ===');

type CompactViolation =
  | { r: string; k: 'dep'; f: string; t: string; s: string; l: number; fix: 'remove-or-invert-import' }
  | { r: string; k: 'cycle'; chain: readonly string[]; fix: 'break-cycle-edge' };

function compact(v: Violation): CompactViolation {
  if (v.kind === 'no-dependency') {
    return { r: v.ruleId, k: 'dep', f: v.fromFile, t: v.toFile, s: v.specifier, l: v.line, fix: 'remove-or-invert-import' };
  }
  return { r: v.ruleId, k: 'cycle', chain: v.chain, fix: 'break-cycle-edge' };
}

const evaluations = evaluateRules(graph, RULES);
const allViolations = evaluations.flatMap((e) => [...e.violations]);

const prosePayload = {
  verdict: 'red',
  totalViolations: allViolations.length,
  rules: evaluations.map((e) => ({ ruleId: e.rule.id, kind: e.rule.kind, violationCount: e.violations.length })),
  violations: evaluations
    .filter((e) => e.violations.length > 0)
    .map((e) => ({ ruleId: e.rule.id, shown: e.violations.length, total: e.violations.length, items: e.violations })),
  uncertainty: { totalCount: graph.uncertain.length },
};
const compactPayload = {
  verdict: 'red',
  counts: Object.fromEntries(evaluations.map((e) => [e.rule.id, e.violations.length])),
  violations: allViolations.map(compact),
  uncertain: graph.uncertain.length,
};

const proseBytes = Buffer.byteLength(JSON.stringify(prosePayload, null, 2), 'utf8');
const compactBytes = Buffer.byteLength(JSON.stringify(compactPayload), 'utf8');
const proseViolationBytes = allViolations.map((v) => Buffer.byteLength(JSON.stringify(v), 'utf8'));
const compactViolationBytes = allViolations.map((v) => Buffer.byteLength(JSON.stringify(compact(v)), 'utf8'));
const avg = (xs: readonly number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));

const compactEnvelope = compactBytes - compactViolationBytes.reduce((a, b) => a + b, 0);
console.log(`prose payload (spike MCP shape, pretty): ${proseBytes} B ≈ ${Math.round(proseBytes / 4)} tokens for ${allViolations.length} violations`);
console.log(`compact payload (structured-only, minified): ${compactBytes} B ≈ ${Math.round(compactBytes / 4)} tokens`);
console.log(`avg violation: prose ${avg(proseViolationBytes)} B ≈ ${Math.round(avg(proseViolationBytes) / 4)} tok | compact ${avg(compactViolationBytes)} B ≈ ${Math.round(avg(compactViolationBytes) / 4)} tok`);
console.log(`compact envelope: ${compactEnvelope} B`);
for (const n of [10, 50, 200]) {
  const projected = compactEnvelope + n * avg(compactViolationBytes);
  console.log(`compact projection ${n} violations: ${projected} B ≈ ${Math.round(projected / 4)} tokens`);
}
