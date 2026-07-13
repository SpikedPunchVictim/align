import { describe, expect, it } from 'vitest';
import { ruleIRSchema } from '@align/core';
import type { z } from 'zod';
import { renderSkillMarkdown } from '../src/skill/render.js';
import { buildProgram } from '../src/program.js';

/**
 * Skill-completeness test (Stage 5, IMPLEMENTATION_PLAN.md "Elevated first items"): walks the
 * LIVE rule-kind union off `ruleIRSchema` — the same zod schema the orchestrator validates every
 * ruleset against — and asserts every kind's literal string appears in the rendered skill
 * markdown. Adding a rule kind to the IR without adding skill coverage (`skill/rule-kinds.ts`'s
 * `RULE_KIND_DESCRIPTIONS`) fails this test, independent of `describeRuleKinds()`'s own
 * throw-on-missing-entry guard — belt and suspenders: this test would also catch a description
 * that got written but never actually rendered into the markdown.
 */
function liveRuleKinds(): readonly string[] {
  const union = ruleIRSchema as unknown as { options: readonly z.ZodObject<{ kind: z.ZodLiteral<string> }>[] };
  return union.options.map((option) => option.shape.kind.value);
}

describe('align skill — completeness (must never drift from the live IR rule-kind union)', () => {
  it('the live schema currently has at least the v1 rule kinds this test expects', () => {
    // Sanity floor — if this list needs updating, the schema grew and the assertions below are
    // exactly the mechanism that should already be failing to tell you so.
    expect(liveRuleKinds()).toEqual(
      expect.arrayContaining(['arch.no-dependency', 'arch.no-cycles', 'arch.layers', 'arch.metric', 'custom.host', 'security.manifest.source-hygiene', 'security.manifest.new-dependency']),
    );
  });

  it('every live rule kind appears in the `--topic all` skill markdown', () => {
    const md = renderSkillMarkdown('all', buildProgram());
    const missing = liveRuleKinds().filter((kind) => !md.includes(kind));
    expect(missing).toEqual([]);
  });

  it('every live rule kind appears in the `--topic authoring` skill markdown', () => {
    const md = renderSkillMarkdown('authoring', buildProgram());
    const missing = liveRuleKinds().filter((kind) => !md.includes(kind));
    expect(missing).toEqual([]);
  });
});
