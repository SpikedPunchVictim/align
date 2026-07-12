import { InMemoryBaselineStore, toRuleId } from '@align/core';
import { loadConfig } from '../config.js';
import { createOrchestrator } from '../composition-root.js';
import { readBaseline, writeBaseline } from '../align-dir.js';

async function currentViolations(rootDir: string) {
  const { ruleset, excludes } = await loadConfig(rootDir);
  // An empty baseline store surfaces every violation as "red" regardless of what's actually
  // baselined on disk — exactly the full current violation set `prune`/`accept` need.
  const { orchestrator } = createOrchestrator(ruleset, []);
  const run = await orchestrator.check({ rootDir, excludes });
  return run.gates.flatMap((g) => g.violations);
}

export async function baselineAccept(rootDir: string, ruleId?: string): Promise<number> {
  const violations = await currentViolations(rootDir);
  const targeted = ruleId === undefined ? violations : violations.filter((v) => v.ruleId === toRuleId(ruleId));
  const store = new InMemoryBaselineStore(readBaseline(rootDir));
  store.accept(targeted, 'manual');
  writeBaseline(rootDir, store.snapshot());
  console.log(`Accepted ${targeted.length} violation(s)${ruleId === undefined ? '' : ` for rule '${ruleId}'`} into the baseline.`);
  return 0;
}

export async function baselinePrune(rootDir: string): Promise<number> {
  const { ruleset, excludes } = await loadConfig(rootDir);
  const store = new InMemoryBaselineStore(readBaseline(rootDir));
  const { orchestrator } = createOrchestrator(ruleset, []);
  const run = await orchestrator.check({ rootDir, excludes });
  const allViolations = run.gates.flatMap((g) => g.violations);
  const result = store.prune(
    { nodes: [], edges: [], uncertain: [], scannedAt: Date.now() },
    allViolations,
  );
  writeBaseline(rootDir, store.snapshot());
  console.log(`Pruned ${result.removed.length} fixed violation(s) from the baseline; ${result.moved.length} moved.`);
  return 0;
}

export async function baselineShow(rootDir: string, ruleId?: string): Promise<number> {
  const store = new InMemoryBaselineStore(readBaseline(rootDir));
  const entries = store.show(ruleId === undefined ? undefined : { ruleId: toRuleId(ruleId) });
  if (entries.length === 0) {
    console.log('Baseline is empty.');
    return 0;
  }
  for (const entry of entries) {
    console.log(`  ${entry.file}  [${entry.ruleId}]  accepted ${new Date(entry.acceptedAt).toISOString()} (${entry.acceptedBy})`);
  }
  console.log(`\n${entries.length} baselined violation(s).`);
  return 0;
}
