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
 * Parses one bullet's sentence into a `RuleFragment` per ADR 011's constrained grammar: component
 * names, "must not depend on", "no cycles", "layers." Returns `undefined` for a sentence that
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

  return undefined;
}

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

    const sentence = match[1].replace(/\.$/, '').trim();
    const range: SourceRange = { startLine: i + 1, endLine: i + 1 };
    const fragment = parseBulletSentence(sentence);
    if (fragment === undefined) {
      errors.push({
        section: section.anchor,
        sourceFile: docPath,
        sourceLineRange: range,
        sourceQuote: line.trim(),
        reason: 'unparsed-bullet',
        detail: `Bullet did not match the tier-2 grammar (component names + "must not depend on" / "no cycles" / "may only depend on"): "${sentence}"`,
      });
      continue;
    }
    bullets.push({ fragment, sourceLineRange: range, sourceQuote: line.trim() });
  }

  return { bullets, errors };
}
