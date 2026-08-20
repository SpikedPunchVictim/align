/**
 * LEDGER D063 — a `custom.host` predicate whose findings share an identity used to report GREEN.
 *
 * Reproduced against the built 0.2.0 binary on the reporter's fixture 09: a predicate returning
 * three findings for `src/index.ts`, all with the message `bad thing here`, on lines 1, 2 and 3,
 * against a baseline holding ONE accepted entry. `align check --json` answered
 * `verdict: green`, `baselinedCount: 3`, `baselineDebt: {previous: 1, current: 1, delta: 0}` —
 * one signature suppressing three findings, two of which no human ever saw, with the debt report
 * actively confirming that nothing had changed.
 *
 * The invariant these tests pin is not "the fingerprint is right"; it is **align never suppresses a
 * finding on the strength of consent given to a different finding.** Where core can see structural
 * coordinates it derives distinctness itself; for `custom.host` the predicate is the only thing that
 * knows, so core's honest move is to refuse rather than guess (the same choice `UnknownHostRuleError`
 * and `UntrustedCustomHostRuleError` already make in this module).
 */
import { describe, expect, it } from 'vitest';
import { GateOrchestrator } from '../../src/orchestrator.js';
import { InMemoryBaselineStore } from '../../src/baseline/store.js';
import { noScanHistory } from '../../src/baseline/scan-history.js';
import { StaticPluginRegistry, type LanguagePlugin } from '../../src/plugin/registry.js';
import { defineProject } from '../../src/dsl/index.js';
import {
  evaluateCustomHost,
  HostViolationCollisionError,
  type HostPredicate,
  type HostPredicateRegistry,
} from '../../src/rules/host-rules.js';
import type { CustomHostRule } from '../../src/types/ir.js';
import type { ScanInput } from '../../src/scanner.js';
import { toRepoRelativePath } from '../../src/types/branded.js';
import { graph, neverOnDisk, node } from '../helpers.js';

const RULE: CustomHostRule = {
  kind: 'custom.host',
  id: 'custom.host:two-findings',
  hostRuleName: 'two-findings',
  portable: false,
  provenance: {},
};

const FILE = toRepoRelativePath('src/index.ts');

function registryOf(predicate: HostPredicate): HostPredicateRegistry {
  return new Map([['two-findings', predicate]]);
}

function oneFileGraph(): ReturnType<typeof graph> {
  return graph([node('src/index.ts', 'app', 3)], []);
}

function fakePlugin(build: (input: ScanInput) => ReturnType<typeof graph>): LanguagePlugin {
  return { id: 'fake', fileMatch: ['**/*.ts'], scanner: { scan: async (input: ScanInput) => build(input) } };
}

describe('custom.host findings that share an identity (LEDGER D063)', () => {
  it('refuses when two findings differ only by line — the pair is indistinguishable to the baseline', () => {
    const predicate: HostPredicate = () => [
      { file: FILE, message: 'bad thing here', range: { startLine: 1, endLine: 1 } },
      { file: FILE, message: 'bad thing here', range: { startLine: 2, endLine: 2 } },
    ];
    expect(() => evaluateCustomHost(RULE, oneFileGraph(), registryOf(predicate))).toThrow(HostViolationCollisionError);
  });

  it('names the rule, the predicate, the file, the colliding message and the remedy', () => {
    const predicate: HostPredicate = () => [
      { file: FILE, message: 'bad thing here', range: { startLine: 1, endLine: 1 } },
      { file: FILE, message: 'bad thing here', range: { startLine: 2, endLine: 2 } },
      { file: FILE, message: 'bad thing here', range: { startLine: 3, endLine: 3 } },
    ];
    try {
      evaluateCustomHost(RULE, oneFileGraph(), registryOf(predicate));
      expect.fail('expected HostViolationCollisionError');
    } catch (err) {
      expect(err).toBeInstanceOf(HostViolationCollisionError);
      const e = err as HostViolationCollisionError;
      expect(e.ruleId).toBe('custom.host:two-findings');
      expect(e.hostRuleName).toBe('two-findings');
      expect(e.file).toBe('src/index.ts');
      expect(e.hostMessage).toBe('bad thing here');
      expect(e.count).toBe(3);
      // Context -> problem -> fix. The count matters: "3 findings" is what tells the author this is
      // their per-occurrence predicate and not a one-off.
      expect(e.message).toContain('custom.host:two-findings');
      expect(e.message).toContain("'two-findings'");
      expect(e.message).toContain('src/index.ts');
      expect(e.message).toContain('bad thing here');
      expect(e.message).toContain('3');
      // The remedy has to be actionable, and it has to say why line numbers are not the answer.
      expect(e.message).toContain('message');
      expect(e.message).toContain('hostRules');
      expect(e.message).toMatch(/line number/i);
    }
  });

  it('does NOT refuse when the messages distinguish the findings — the documented authoring form keeps working', () => {
    const predicate: HostPredicate = () => [
      { file: FILE, message: "'one' is not allowed", range: { startLine: 1, endLine: 1 } },
      { file: FILE, message: "'two' is not allowed", range: { startLine: 2, endLine: 2 } },
    ];
    const violations = evaluateCustomHost(RULE, oneFileGraph(), registryOf(predicate));
    expect(violations).toHaveLength(2);
    expect(new Set(violations.map((v) => v.id)).size).toBe(2);
  });

  it('does NOT refuse when the same finding is emitted twice with every field equal — that is one finding, reported once', () => {
    // A predicate with two overlapping detection passes emits the identical finding twice. It is
    // observably ONE violation (same file, message, range, snippet), so collapsing it is honest and
    // the "make your messages distinct" advice would be wrong guidance here.
    const hv = { file: FILE, message: 'bad thing here', range: { startLine: 1, endLine: 1 }, snippet: 'export const one = 1' };
    const violations = evaluateCustomHost(RULE, oneFileGraph(), registryOf(() => [hv, { ...hv }]));
    expect(violations).toHaveLength(1);
  });

  it('keeps every OTHER finding when one of them was a duplicate — dedup must not swallow the rest', () => {
    // The dedup branch only runs when some group has more than one member, so a mixed batch (one
    // duplicated finding plus untouched ones) is the case where a bug there costs a real violation
    // its report. Added because a mutation that dropped every single-member group survived the rest
    // of this file: those tests all had either no duplicates or nothing BUT duplicates.
    const dup = { file: FILE, message: 'seen twice', range: { startLine: 1, endLine: 1 }, snippet: 'x' };
    const predicate: HostPredicate = () => [
      dup,
      { ...dup },
      { file: FILE, message: 'seen once', range: { startLine: 2, endLine: 2 }, snippet: 'y' },
    ];
    const violations = evaluateCustomHost(RULE, oneFileGraph(), registryOf(predicate));
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => (v.kind === 'custom' ? v.detail : ''))).toEqual(['seen twice', 'seen once']);
  });

  it('refuses when the ranges match but the snippets differ — same line, genuinely different findings', () => {
    const predicate: HostPredicate = () => [
      { file: FILE, message: 'bad thing here', range: { startLine: 1, endLine: 1 }, snippet: 'a' },
      { file: FILE, message: 'bad thing here', range: { startLine: 1, endLine: 1 }, snippet: 'b' },
    ];
    expect(() => evaluateCustomHost(RULE, oneFileGraph(), registryOf(predicate))).toThrow(HostViolationCollisionError);
  });

  it('does not confuse findings in different files that share a message', () => {
    const g = graph([node('src/index.ts', 'app', 3), node('src/other.ts', 'app', 3)], []);
    const predicate: HostPredicate = () => [
      { file: FILE, message: 'bad thing here' },
      { file: toRepoRelativePath('src/other.ts'), message: 'bad thing here' },
    ];
    const violations = evaluateCustomHost(RULE, g, registryOf(predicate));
    expect(violations).toHaveLength(2);
    expect(new Set(violations.map((v) => v.id)).size).toBe(2);
  });

  it('the reporter fixture reports ERROR, never green: one accepted entry cannot cover three findings', async () => {
    const ruleset = defineProject({
      components: { app: 'src/**' },
      rules: (c) => [c.custom.host('two-findings')],
    });
    const predicate: HostPredicate = () => [
      { file: FILE, message: 'bad thing here', range: { startLine: 1, endLine: 1 } },
      { file: FILE, message: 'bad thing here', range: { startLine: 2, endLine: 2 } },
      { file: FILE, message: 'bad thing here', range: { startLine: 3, endLine: 3 } },
    ];
    const registry = new StaticPluginRegistry([fakePlugin(() => oneFileGraph())]);
    const orchestrator = new GateOrchestrator(
      registry,
      ruleset,
      new InMemoryBaselineStore([], neverOnDisk, noScanHistory()),
      registryOf(predicate),
    );
    const run = await orchestrator.check({ rootDir: '/repo', excludes: [] });

    expect(run.verdict).toBe('error');
    const archGate = run.gates.find((g) => g.gate === 'architecture');
    expect(archGate?.status).toBe('error');
    expect(archGate?.errorMessage).toContain('bad thing here');
    // The specific lie 0.2.0 told: no violation may be reported as accepted here.
    expect(archGate?.baselinedCount ?? 0).toBe(0);
  });
});
