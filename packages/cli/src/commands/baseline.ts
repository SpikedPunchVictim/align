import { InMemoryBaselineStore, toRuleId } from '@spikedpunch/align-core';
import { loadConfig } from '../config.js';
import { createOrchestrator } from '../composition-root.js';
import { readBaseline, writeBaseline } from '../align-dir.js';
import { computeRulesetIrHash, createTelemetryRecorder } from '../telemetry/index.js';

async function currentViolations(rootDir: string) {
  const { ruleset, excludes, hostRules, telemetry } = await loadConfig(rootDir);
  // An empty baseline store surfaces every violation as "red" regardless of what's actually
  // baselined on disk — exactly the full current violation set `prune`/`accept` need.
  const { orchestrator } = createOrchestrator(ruleset, [], hostRules);
  const run = await orchestrator.check({ rootDir, excludes });
  return { violations: run.gates.flatMap((g) => g.violations), ruleset, telemetry };
}

export async function baselineAccept(rootDir: string, ruleId?: string, telemetryPreConfig?: boolean): Promise<number> {
  const { violations, ruleset, telemetry } = await currentViolations(rootDir);
  const targeted = ruleId === undefined ? violations : violations.filter((v) => v.ruleId === toRuleId(ruleId));
  const store = new InMemoryBaselineStore(readBaseline(rootDir));
  store.accept(targeted, 'manual');
  writeBaseline(rootDir, store.snapshot());
  console.log(`Accepted ${targeted.length} violation(s)${ruleId === undefined ? '' : ` for rule '${ruleId}'`} into the baseline.`);

  const recorder = createTelemetryRecorder(rootDir, 'baseline accept', telemetryPreConfig, telemetry);
  recorder.record(
    {
      kind: 'baseline',
      action: 'accept',
      counts: { accepted: targeted.length },
      ...(ruleId !== undefined ? { ruleScope: ruleId } : {}),
    },
    { rulesetIrHash: computeRulesetIrHash(ruleset) },
  );
  return 0;
}

export async function baselinePrune(rootDir: string, telemetryPreConfig?: boolean): Promise<number> {
  const { ruleset, excludes, hostRules, telemetry } = await loadConfig(rootDir);
  const store = new InMemoryBaselineStore(readBaseline(rootDir));
  const { orchestrator } = createOrchestrator(ruleset, [], hostRules);
  const run = await orchestrator.check({ rootDir, excludes });
  const allViolations = run.gates.flatMap((g) => g.violations);
  const result = store.prune(
    { nodes: [], edges: [], externalNodes: [], externalEdges: [], uncertain: [], scannedAt: Date.now() },
    allViolations,
  );
  writeBaseline(rootDir, store.snapshot());
  console.log(
    `Pruned ${result.removed.length} fixed violation(s) from the baseline; ` +
      `${result.moved.length} ${result.moved.length === 1 ? 'entry' : 'entries'} transferred (file moves).`,
  );

  const recorder = createTelemetryRecorder(rootDir, 'baseline prune', telemetryPreConfig, telemetry);
  recorder.record(
    { kind: 'baseline', action: 'prune', counts: { removed: result.removed.length, moved: result.moved.length } },
    { rulesetIrHash: computeRulesetIrHash(ruleset) },
  );
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
