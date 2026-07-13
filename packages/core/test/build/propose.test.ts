import { describe, expect, it } from 'vitest';
import { proposeRulesFromDoc } from '../../src/build/propose.js';
import { diffGeneratedRules } from '../../src/build/diff.js';
import { toComponentName, toRepoRelativePath } from '../../src/types/branded.js';
import type { ComponentDefinitionIR } from '../../src/types/ir.js';

const components: Record<string, ComponentDefinitionIR> = {
  core: { name: toComponentName('core'), selector: { kind: 'glob', patterns: ['packages/core/**'] }, empty: 'fail' },
  cli: { name: toComponentName('cli'), selector: { kind: 'glob', patterns: ['packages/cli/**'] }, empty: 'fail' },
  pluginTypescript: { name: toComponentName('pluginTypescript'), selector: { kind: 'glob', patterns: ['packages/plugin-typescript/**'] }, empty: 'fail' },
};

const docPath = toRepoRelativePath('docs/ARCHITECTURE-RULES.md');

function doc(): string {
  return [
    '# Architecture Rules',
    '',
    '## Plugin Isolation',
    '',
    'plugin-typescript must only depend on core.',
    '',
    '```align',
    '{"kind":"arch.layers","layers":[{"layer":"pluginTypescript","canDependOn":["core"]}]}',
    '```',
    '',
    '## Core Isolation',
    '',
    '- **Rule**: `core` must not depend on `cli`.',
    '',
    '## No Cycles',
    '',
    '- **Rule**: No cycles.',
    '',
    '## Philosophy',
    '',
    'The system should generally be modular and easy to reason about.',
    '',
  ].join('\n');
}

describe('proposeRulesFromDoc', () => {
  it('classifies sections by tier and extracts rules deterministically', () => {
    const result = proposeRulesFromDoc(doc(), docPath, components);
    const byAnchor = new Map(result.sections.map((s) => [s.anchor, s]));
    expect(byAnchor.get('plugin-isolation')?.tier).toBe('verbatim');
    expect(byAnchor.get('core-isolation')?.tier).toBe('bullet');
    expect(byAnchor.get('no-cycles')?.tier).toBe('bullet');
    expect(byAnchor.get('philosophy')?.tier).toBe('prose');

    expect(result.proseSections).toHaveLength(1);
    expect(result.proseSections[0]?.anchor).toBe('philosophy');
    expect(result.proseSections[0]?.concerns).toEqual([]); // align never invents concerns

    expect(result.rules.map((r) => r.id).sort()).toEqual([
      'arch.layers:pluginTypescript',
      'arch.no-cycles:repo',
      'arch.no-dependency:core->cli',
    ]);
    expect(result.flagged).toHaveLength(0);
  });

  it('rewording one section only changes that section\'s rules and hash — an unrelated section is byte-identical', () => {
    const original = proposeRulesFromDoc(doc(), docPath, components);

    // The edit adds lines to the LAST rule-bearing section ("No Cycles" — "Philosophy" after it
    // has no rules), so it can't shift the line numbers of any other section's rules: a reword
    // that changes a section's own line count only affects rules whose lines are AFTER the edit
    // within the doc, which is precisely why this fixture is ordered with the edited section last.
    const reworded = doc().replace(
      '## No Cycles\n\n- **Rule**: No cycles.',
      '## No Cycles\n\nClarification: this applies repo-wide, not just within one package.\n\n- **Rule**: No cycles.',
    );
    const changedDoc = proposeRulesFromDoc(reworded, docPath, components);

    const originalByAnchor = new Map(original.sections.map((s) => [s.anchor, s]));
    const changedByAnchor = new Map(changedDoc.sections.map((s) => [s.anchor, s]));

    expect(changedByAnchor.get('no-cycles')?.contentHash).not.toBe(originalByAnchor.get('no-cycles')?.contentHash);
    // Untouched sections keep the exact same hash and produce byte-identical rules.
    expect(changedByAnchor.get('plugin-isolation')?.contentHash).toBe(originalByAnchor.get('plugin-isolation')?.contentHash);
    expect(changedByAnchor.get('core-isolation')?.contentHash).toBe(originalByAnchor.get('core-isolation')?.contentHash);

    const diff = diffGeneratedRules(original.rules, changedDoc.rules);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    // The reworded section's own rule has a moved provenance line (sourceLineRange) but the same
    // structural fields (kind/scope/includeTypeOnly) — that's a provenance-only change (Stage 5
    // infra fix, `build/diff.ts`'s `RuleDiff.provenanceOnlyChanged`), not a structural one. The
    // other two rules — from sections the edit didn't touch or shift — are fully unchanged.
    expect(diff.changed).toHaveLength(0);
    expect(diff.provenanceOnlyChanged.map((c) => c.after.id)).toEqual(['arch.no-cycles:repo']);
    expect(diff.unchanged.map((r) => r.id).sort()).toEqual(['arch.layers:pluginTypescript', 'arch.no-dependency:core->cli']);
  });

  it('an IR-identical re-proposal (typo fix elsewhere in a section) yields an empty diff', () => {
    const original = proposeRulesFromDoc(doc(), docPath, components);

    // Simulates "unrelated text changed elsewhere in the section, but this rule's own line
    // didn't move" — text is appended AFTER the bullet (not before, which would shift its line
    // number and legitimately change its provenance) so the bullet's own quote/range/content stay
    // byte-identical while the section's hash still changes (triggering re-parse of the section).
    const retyped = doc().replace(
      '- **Rule**: No cycles.\n\n## Philosophy',
      '- **Rule**: No cycles.\n\nSee below for the constraint.\n\n## Philosophy',
    );
    const reproposed = proposeRulesFromDoc(retyped, docPath, components);

    const diff = diffGeneratedRules(original.rules, reproposed.rules);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(3); // fully empty diff — every rule is byte-identical
  });

  it("R5: a tier-2 bullet's trailing \"Because ...\" clause reaches the compiled rule's provenance.because, prepended to the auto-generated 'Enforced by' quote — same convergence as a tier-1 fragment's authored because", () => {
    const withBecause = ['## Core Isolation', '', '- **Rule**: `core` must not depend on `cli`. Because core must stay a leaf dependency.', ''].join(
      '\n',
    );
    const result = proposeRulesFromDoc(withBecause, docPath, components);
    expect(result.flagged).toHaveLength(0);
    const rule = result.rules.find((r) => r.id === 'arch.no-dependency:core->cli');
    expect(rule?.provenance.because).toBe(
      "core must stay a leaf dependency Enforced by docs/ARCHITECTURE-RULES.md:3: '- **Rule**: `core` must not depend on `cli`. Because core must stay a leaf dependency.'",
    );
  });

  it('flags an ungroundable component rather than silently writing a rule', () => {
    const badDoc = ['## Bad', '', '- **Rule**: `core` must not depend on `nonexistent`.', ''].join('\n');
    const result = proposeRulesFromDoc(badDoc, docPath, components);
    expect(result.rules).toHaveLength(0);
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0]?.reason).toBe('ungroundable-selector');
  });

  it('flags disagreeing proposals for the same rule id instead of picking a winner', () => {
    const conflicting = [
      '## A',
      '',
      '```align',
      '{"kind":"arch.no-cycles","scope":"core","includeTypeOnly":false}',
      '```',
      '',
      '## B',
      '',
      '```align',
      '{"kind":"arch.no-cycles","scope":"core","includeTypeOnly":true}',
      '```',
      '',
    ].join('\n');
    const result = proposeRulesFromDoc(conflicting, docPath, components);
    expect(result.rules).toHaveLength(0);
    expect(result.flagged.filter((f) => f.reason === 'conflicting-rule-id')).toHaveLength(2);
  });
});
