import { toRepoRelativePath, type ComponentName, type RepoRelativePath, type RuleId } from '../types/branded.js';
import type { ComponentDefinitionIR, RuleIR } from '../types/ir.js';
import { parseMarkdownDoc } from './sections.js';
import { extractFencedAlignBlocks } from './tier1.js';
import { extractStructuredBullets } from './tier2.js';
import { groundFragment } from './ground.js';
import type { BuildProposal, FlaggedProposal, ProseSectionScaffold, SectionClassification, SectionTier } from './types.js';

interface Candidate {
  readonly sectionAnchor: string;
  readonly rule: RuleIR;
}

/** Structural equality for conflict detection — everything except `id` (which two candidates
 * sharing a group already share by definition) and `provenance` (which legitimately differs by
 * source location even for the same semantic rule). */
function structurallyEqual(a: RuleIR, b: RuleIR): boolean {
  const strip = (r: RuleIR): unknown => {
    const { provenance: _provenance, ...rest } = r;
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/**
 * Extracts, grounds, and deduplicates rule proposals from an architecture/best-practices markdown
 * doc (ADR 011's precision ladder, tiers 1+2 — this stage's CLI path is zero-LLM; tier 3 prose
 * surfaces as a `proseSections` scaffold, never compiled here). Pure — no I/O, no LLM.
 *
 * Rule ids are content-addressed (derived from `kind` + the rule's own selectors, the same scheme
 * `dsl/index.ts` uses — see `ground.ts`), which is what makes ADR 011's rule-level diff
 * minimization trivial: an IR-identical re-proposal always produces the same id, so a caller
 * diffing this function's output against a previous run's `rules` array sees an empty diff for
 * anything that didn't structurally change, with zero stateful bookkeeping.
 */
export function proposeRulesFromDoc(
  docText: string,
  docPath: RepoRelativePath,
  components: Readonly<Record<ComponentName, ComponentDefinitionIR>>,
): BuildProposal {
  const { lines, sections } = parseMarkdownDoc(docText);
  const flagged: FlaggedProposal[] = [];
  const proseSections: ProseSectionScaffold[] = [];
  const candidates: Candidate[] = [];
  const sectionMeta: { readonly anchor: string; readonly headingText: string; readonly startLine: number; readonly endLine: number; readonly contentHash: string; readonly tier: SectionTier }[] = [];

  for (const section of sections) {
    const tier1 = extractFencedAlignBlocks(lines, section, docPath);
    const tier2 = extractStructuredBullets(lines, section, docPath);
    flagged.push(...tier1.errors, ...tier2.errors);

    for (const f of tier1.fragments) {
      const result = groundFragment(f.fragment, section.anchor, docPath, f.sourceLineRange, f.sourceQuote, components);
      if (result.ok) candidates.push({ sectionAnchor: section.anchor, rule: result.rule });
      else flagged.push(result.flagged);
    }
    for (const b of tier2.bullets) {
      const result = groundFragment(b.fragment, section.anchor, docPath, b.sourceLineRange, b.sourceQuote, components);
      if (result.ok) candidates.push({ sectionAnchor: section.anchor, rule: result.rule });
      else flagged.push(result.flagged);
    }

    let tier: SectionTier;
    if (tier1.fragments.length > 0 || tier1.errors.length > 0) tier = 'verbatim';
    else if (tier2.bullets.length > 0 || tier2.errors.length > 0) tier = 'bullet';
    else if (section.bodyText.trim().length > 0) tier = 'prose';
    else tier = 'empty';

    if (tier === 'prose') {
      proseSections.push({
        anchor: section.anchor,
        headingText: section.headingText,
        startLine: section.startLine,
        endLine: section.endLine,
        concerns: [],
      });
    }

    sectionMeta.push({
      anchor: section.anchor,
      headingText: section.headingText,
      startLine: section.startLine,
      endLine: section.endLine,
      contentHash: section.contentHash,
      tier,
    });
  }

  // Resolve id collisions: candidates sharing an id are either the same rule proposed from
  // multiple places (fine — keep the earliest by document order) or a genuine disagreement
  // (different `includeTypeOnly`/`canDependOn` for the same scope/layer) — flag every candidate in
  // a disagreeing group rather than silently picking a winner (ADR 011: never silently written).
  const byId = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byId.get(c.rule.id);
    if (list === undefined) byId.set(c.rule.id, [c]);
    else list.push(c);
  }

  const finalRules: RuleIR[] = [];
  const finalRuleIdsBySection = new Map<string, RuleId[]>();
  const recordRuleId = (anchor: string, id: RuleId): void => {
    const list = finalRuleIdsBySection.get(anchor);
    if (list === undefined) finalRuleIdsBySection.set(anchor, [id]);
    else list.push(id);
  };

  for (const [id, group] of byId) {
    const first = group[0];
    if (first === undefined) continue;
    const allEqual = group.every((c) => structurallyEqual(c.rule, first.rule));
    if (allEqual) {
      finalRules.push(first.rule);
      recordRuleId(first.sectionAnchor, first.rule.id as RuleId);
      continue;
    }
    for (const c of group) {
      flagged.push({
        section: c.sectionAnchor,
        sourceFile: c.rule.provenance.sourceFile === undefined ? docPath : toRepoRelativePath(c.rule.provenance.sourceFile),
        sourceLineRange: c.rule.provenance.sourceLineRange ?? { startLine: 1, endLine: 1 },
        sourceQuote: c.rule.provenance.sourceQuote ?? '',
        reason: 'conflicting-rule-id',
        detail: `Rule id '${id}' was proposed with disagreeing content across sections — resolve the conflict in the doc before building.`,
      });
    }
  }

  const sectionsOut: SectionClassification[] = sectionMeta.map((s) => ({
    ...s,
    ruleIds: [...new Set(finalRuleIdsBySection.get(s.anchor) ?? [])],
  }));

  return { sections: sectionsOut, rules: finalRules, flagged, proseSections };
}
