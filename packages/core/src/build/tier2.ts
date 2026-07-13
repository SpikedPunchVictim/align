import type { RepoRelativePath } from '../types/branded.js';
import type { SourceRange } from '../types/violation.js';
import type { DocSection } from './sections.js';
import type { RuleFragment } from './schema.js';
import type { FlaggedProposal } from './types.js';

export interface ExtractedBullet {
  readonly fragment: RuleFragment;
  readonly sourceLineRange: SourceRange;
  readonly sourceQuote: string;
}

const BULLET_RE = /^\s*-\s+\*\*Rule\*\*:\s*(.+?)\s*$/i;

const NO_CYCLES_SCOPED_RE = /^no\s+cycles?(?:\s+(?:allowed|permitted))?\s+(?:within|in|for)\s+(.+?)\.?$/i;
const NO_CYCLES_BARE_RE = /^no\s+cycles?\.?$/i;
const NO_CYCLES_SUBJECT_RE = /^(.+?)\s+must\s+have\s+no\s+cycles?\.?$/i;
const NO_DEPENDENCY_RE = /^(.+?)\s+must\s+not\s+depend\s+on\s+(.+?)\.?$/i;
const LAYERS_RE = /^(.+?)\s+(?:may|can)\s+only\s+depend\s+on\s+(.+?)\.?$/i;
// `arch.metric` (max-LOC only, promoted 2026-07-12 on kluster ruleset evidence,
// IMPLEMENTATION_PLAN.md's Promotion log). Mirrors the DSL's `.maxLinesPerFile(max)`
// (dsl/index.ts) — only the `loc` metric has a tier-2 grammar; fan-in/fan-out/instability stay
// reserved pending their own evidence and gain their own bullet grammar when promoted.
const MAX_LOC_RE = /^files\s+in\s+(.+?)\s+must\s+stay\s+under\s+(\d+)\s+lines?\.?$/i;
// `security.manifest.*` (ADR 013, promoted 2026-07-12 on probe evidence). Bare-sentence forms,
// same shape as `NO_CYCLES_BARE_RE` — neither rule takes a component target, so there is nothing
// to capture.
const SOURCE_HYGIENE_RE = /^dependenc(?:y|ies)\s+(?:sources?\s+)?must\s+be\s+(?:sourced\s+from\s+)?(?:the\s+)?registry(?:[- ]only)?\.?$/i;
const NEW_DEPENDENCY_GATE_RE = /^new\s+dependenc(?:y|ies)\s+(?:requires?|needs?)\s+baseline\s+(?:approval|acceptance)\.?$/i;

/** Splits a target-list clause ("`core`, `cli` and `pluginTypescript`") into raw tokens.
 * Backtick/quote stripping happens at grounding time (`ground.ts`), not here — tier 2 stays a
 * pure sentence splitter. */
function splitTokens(clause: string): string[] {
  return clause
    .split(/\s*,\s*|\s+and\s+|\s+or\s+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * R5 (precision-ladder gap, GREENFIELD_TRIAD_REPORT.md §1): tier-2 bullets had no field for an
 * authored rationale — only fenced-JSON blocks (tier 1) could carry `.because()` text, capping the
 * greenfield demo's `.because()` coverage at 75% for no reason other than which tier a rule was
 * authored in. Splits an optional trailing "Because <rationale>." clause off a bullet's rule
 * sentence: "api may only depend on core. Because the API layer must stay headless." -> sentence
 * "api may only depend on core", because "the API layer must stay headless". The result flows
 * straight into `RuleFragment.because` (every fragment variant already has this optional field,
 * `schema.ts` — the same field a tier-1 fenced block's own `"because"` JSON key populates), so
 * `groundFragment`/`buildProvenance` (`ground.ts`/`provenance.ts`) need no changes at all: an
 * authored tier-2 rationale is prepended to the auto-generated "Enforced by <doc>:<line>: '<quote>'"
 * phrase exactly like a tier-1 fragment's `because` is.
 *
 * The literal period-then-"Because" boundary is the deterministic separator — no NLP, and no
 * ambiguity with a rule sentence that happens to use the word "because" without that boundary
 * (which simply isn't matched, and flows through unsplit, same as today).
 */
const TRAILING_BECAUSE_RE = /^(.*?)\.\s+Because\s+(.+?)\s*\.?$/i;

function splitBecauseClause(raw: string): { readonly sentence: string; readonly because: string | undefined } {
  const trimmed = raw.trim();
  const match = TRAILING_BECAUSE_RE.exec(trimmed);
  if (match?.[1] !== undefined && match[2] !== undefined && match[2].length > 0) {
    return { sentence: match[1].trim(), because: match[2].trim() };
  }
  return { sentence: trimmed.replace(/\.$/, '').trim(), because: undefined };
}

/**
 * Parses one bullet's sentence into a `RuleFragment` per ADR 011's constrained grammar: component
 * names, "must not depend on", "no cycles", "layers," "must stay under N lines" (`arch.metric`,
 * max-LOC only). Returns `undefined` for a sentence that
 * doesn't match any known pattern — the caller flags it as `unparsed-bullet` rather than guessing.
 * Deterministic regex matching only — no LLM, no fuzzy matching (this stage's CLI build path is
 * zero-LLM by design; see the Stage 3 report's ADR-011-ambiguity resolutions).
 */
export function parseBulletSentence(sentence: string): RuleFragment | undefined {
  const scopedCycles = NO_CYCLES_SCOPED_RE.exec(sentence);
  if (scopedCycles?.[1] !== undefined) {
    return { kind: 'arch.no-cycles', scope: scopedCycles[1].trim() };
  }
  if (NO_CYCLES_BARE_RE.test(sentence)) {
    return { kind: 'arch.no-cycles', scope: 'repo' };
  }
  const subjectCycles = NO_CYCLES_SUBJECT_RE.exec(sentence);
  if (subjectCycles?.[1] !== undefined) {
    return { kind: 'arch.no-cycles', scope: subjectCycles[1].trim() };
  }

  const noDependency = NO_DEPENDENCY_RE.exec(sentence);
  if (noDependency?.[1] !== undefined && noDependency[2] !== undefined) {
    const from = splitTokens(noDependency[1])[0];
    const targets = splitTokens(noDependency[2]);
    const to = targets[0];
    // Single from -> single to is the only shape a RuleFragment can express (a "from must not
    // depend on A, B" bullet with multiple targets isn't representable as one fragment — the
    // caller sees `undefined` here and flags it as unparsed rather than silently dropping targets;
    // multi-target denylists are `align.layers`'s job, or split into multiple bullets).
    if (from === undefined || to === undefined || targets.length > 1) return undefined;
    return { kind: 'arch.no-dependency', from, to };
  }

  const layers = LAYERS_RE.exec(sentence);
  if (layers?.[1] !== undefined && layers[2] !== undefined) {
    const layerTokens = splitTokens(layers[1]);
    const layer = layerTokens[0];
    const canDependOn = splitTokens(layers[2]);
    if (layer === undefined || layerTokens.length > 1 || canDependOn.length === 0) return undefined;
    return { kind: 'arch.layers', layers: [{ layer, canDependOn }] };
  }

  const maxLoc = MAX_LOC_RE.exec(sentence);
  if (maxLoc?.[1] !== undefined && maxLoc[2] !== undefined) {
    const targetTokens = splitTokens(maxLoc[1]);
    const target = targetTokens[0];
    const max = Number.parseInt(maxLoc[2], 10);
    // Single target only — same "a RuleFragment can express one grounded target" discipline as
    // `NO_DEPENDENCY_RE`/`LAYERS_RE` above.
    if (target === undefined || targetTokens.length > 1 || !Number.isFinite(max)) return undefined;
    return { kind: 'arch.metric', target, metric: 'loc', max };
  }

  if (SOURCE_HYGIENE_RE.test(sentence)) {
    return { kind: 'security.manifest.source-hygiene' };
  }
  if (NEW_DEPENDENCY_GATE_RE.test(sentence)) {
    return { kind: 'security.manifest.new-dependency' };
  }

  return undefined;
}

/**
 * Human-readable grammar-form catalog (Stage 5, IMPLEMENTATION_PLAN.md) — the single source
 * `align skill`'s generated bullet-grammar section reads (`packages/cli/src/skill/bullet-
 * grammar.ts`). Each `example` is asserted against the real `parseBulletSentence` in
 * `test/build-tier2-grammar-catalog.test.ts`: if a regex above changes shape and an example stops
 * matching (or starts producing a different rule kind), that test fails — the catalog cannot
 * silently drift from the parser it describes.
 */
export interface BulletGrammarForm {
  readonly ruleKind: RuleFragment['kind'];
  readonly pattern: string;
  readonly example: string;
}

/** Appended to every pattern below (R5): any bullet may carry an optional trailing rationale
 * clause, parsed into the rule's `.because()` provenance — a period then the literal word
 * "Because" is the deterministic boundary between the rule sentence and the rationale. */
const BECAUSE_SUFFIX = ' Optionally followed by " Because <rationale>." to record why (e.g. "... Because the API layer must stay headless.") — parsed into the rule\'s .because() provenance.';

export const BULLET_GRAMMAR_FORMS: readonly BulletGrammarForm[] = [
  {
    ruleKind: 'arch.no-dependency',
    pattern: `<component> must not depend on <component>.${BECAUSE_SUFFIX}`,
    example: 'api must not depend on ui.',
  },
  {
    ruleKind: 'arch.layers',
    pattern: `<component> may|can only depend on <component>[, <component> and/or <component>...].${BECAUSE_SUFFIX}`,
    example: 'api may only depend on core.',
  },
  {
    ruleKind: 'arch.no-cycles',
    pattern: `no cycles. | no cycles within|in|for <scope>. | <scope> must have no cycles.${BECAUSE_SUFFIX}`,
    example: 'no cycles.',
  },
  {
    ruleKind: 'arch.metric',
    pattern: `files in <component> must stay under <N> lines.${BECAUSE_SUFFIX}`,
    example: 'files in core must stay under 500 lines.',
  },
  {
    ruleKind: 'security.manifest.source-hygiene',
    pattern: `dependency|dependencies (sources) must be (sourced from the) registry(-only).${BECAUSE_SUFFIX}`,
    example: 'dependency sources must be registry-only.',
  },
  {
    ruleKind: 'security.manifest.new-dependency',
    pattern: `new dependency|dependencies requires|needs baseline approval|acceptance.${BECAUSE_SUFFIX}`,
    example: 'new dependency requires baseline approval.',
  },
];

/**
 * Tier 2 of the precision ladder (ADR 011): structured `- **Rule**: ...` bullets parse
 * deterministically. Pure — no I/O.
 */
export function extractStructuredBullets(
  lines: readonly string[],
  section: DocSection,
  docPath: RepoRelativePath,
): { readonly bullets: readonly ExtractedBullet[]; readonly errors: readonly FlaggedProposal[] } {
  const bullets: ExtractedBullet[] = [];
  const errors: FlaggedProposal[] = [];

  const bodyStart = section.startLine;
  const bodyEndExclusive = section.endLine;

  for (let i = bodyStart; i < bodyEndExclusive; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = BULLET_RE.exec(line);
    if (match?.[1] === undefined) continue;

    const { sentence, because } = splitBecauseClause(match[1]);
    const range: SourceRange = { startLine: i + 1, endLine: i + 1 };
    const fragment = parseBulletSentence(sentence);
    if (fragment === undefined) {
      errors.push({
        section: section.anchor,
        sourceFile: docPath,
        sourceLineRange: range,
        sourceQuote: line.trim(),
        reason: 'unparsed-bullet',
        detail: `Bullet did not match the tier-2 grammar (component names + "must not depend on" / "no cycles" / "may only depend on" / "must stay under N lines"): "${sentence}"`,
      });
      continue;
    }
    bullets.push({
      fragment: because === undefined ? fragment : ({ ...fragment, because } as RuleFragment),
      sourceLineRange: range,
      sourceQuote: line.trim(),
    });
  }

  return { bullets, errors };
}
