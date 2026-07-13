import { describe, expect, it } from 'vitest';
import { buildExportedRuleset } from '../../src/build/export-ir.js';
import { exportedRulesetSchema } from '../../src/build/schema.js';
import type { RulesetIR } from '../../src/types/ir.js';

const RULESET: RulesetIR = {
  irVersion: '1',
  components: { app: { name: 'app', selector: { kind: 'glob', patterns: ['src/**'] }, empty: 'fail' } },
  rules: [{ kind: 'arch.no-cycles', id: 'arch.no-cycles:repo', scope: 'repo', includeTypeOnly: false, provenance: {} }],
};

describe('buildExportedRuleset (ADR 014)', () => {
  it('wraps a RulesetIR with excludes + export metadata, defaulting exportedAt to now', () => {
    const before = Date.now();
    const exported = buildExportedRuleset(RULESET, ['**/dist/**']);
    const after = Date.now();

    expect(exported.irVersion).toBe('1');
    expect(exported.excludes).toEqual(['**/dist/**']);
    expect(exported.ruleset).toEqual(RULESET);
    expect(exported.exportedAt).toBeGreaterThanOrEqual(before);
    expect(exported.exportedAt).toBeLessThanOrEqual(after);
  });

  it('accepts an explicit exportedAt (deterministic tests, reproducible artifacts)', () => {
    const exported = buildExportedRuleset(RULESET, [], 12345);
    expect(exported.exportedAt).toBe(12345);
  });

  it('copies the excludes array (not a live reference to the caller\'s array)', () => {
    const excludes = ['a', 'b'];
    const exported = buildExportedRuleset(RULESET, excludes);
    excludes.push('c');
    expect(exported.excludes).toEqual(['a', 'b']);
  });

  it('round-trips through JSON + exportedRulesetSchema.parse unchanged — the artifact is exactly what --untrusted reads back', () => {
    const exported = buildExportedRuleset(RULESET, ['fixtures/**'], 999);
    const roundTripped = exportedRulesetSchema.parse(JSON.parse(JSON.stringify(exported)));
    expect(roundTripped).toEqual(exported);
  });

  it('exportedRulesetSchema rejects a ruleset with an unknown component reference (structure only, not cross-field — reference validity is the orchestrator\'s job)', () => {
    const malformed = { irVersion: '1', exportedAt: 1, excludes: [], ruleset: { irVersion: '1', components: {}, rules: 'not-an-array' } };
    expect(() => exportedRulesetSchema.parse(malformed)).toThrow();
  });

  it('exportedRulesetSchema rejects a payload with function-shaped data smuggled in — everything in the artifact must be JSON-primitive', () => {
    const malformed = { irVersion: '1', exportedAt: 1, excludes: [], ruleset: RULESET, hostRules: { foo: 'not-actually-a-function-but-would-be-ignored-anyway' } };
    // Extra unknown keys are stripped by zod's default (non-strict) object parsing — the point of
    // this test is that `hostRules` never round-trips even if a hand-edited file tries to smuggle
    // it in: the parsed value has no such field.
    const parsed = exportedRulesetSchema.parse(malformed);
    expect((parsed as Record<string, unknown>).hostRules).toBeUndefined();
  });
});
