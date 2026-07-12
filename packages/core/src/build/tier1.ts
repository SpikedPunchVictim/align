import type { RepoRelativePath } from '../types/branded.js';
import type { SourceRange } from '../types/violation.js';
import type { DocSection } from './sections.js';
import { ruleFragmentSchema, type RuleFragment } from './schema.js';
import type { FlaggedProposal } from './types.js';

export interface ExtractedFragment {
  readonly fragment: RuleFragment;
  readonly sourceLineRange: SourceRange;
  /** Tier-1 sourceQuote is the fenced block's own JSON content (trimmed) — there is no separate
   * prose to quote for a verbatim block; the block itself IS the doc's declared intent (an
   * explicit ADR 011 resolution — see the Stage 3 final report's "ambiguities resolved" list). */
  readonly sourceQuote: string;
}

const FENCE_OPEN_RE = /^```align\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;

/**
 * Tier 1 of the precision ladder (ADR 011): fenced ` ```align ` code blocks compile verbatim,
 * zero LLM involved. Each block's content is a **JSON RuleFragment** (`schema.ts`) — the
 * structural fields of one `RuleIR` variant, minus `id`/`provenance` (both are always assigned by
 * the build pipeline, never authored — see `ground.ts`). Pure — no I/O.
 */
export function extractFencedAlignBlocks(
  lines: readonly string[],
  section: DocSection,
  docPath: RepoRelativePath,
): { readonly fragments: readonly ExtractedFragment[]; readonly errors: readonly FlaggedProposal[] } {
  const fragments: ExtractedFragment[] = [];
  const errors: FlaggedProposal[] = [];

  const bodyStart = section.startLine; // 0-indexed first body line (section.startLine is the
  // 1-based heading line; the body's first line is index === that 1-based number)
  const bodyEndExclusive = section.endLine; // 0-indexed exclusive end (section.endLine is 1-based inclusive)

  let i = bodyStart;
  while (i < bodyEndExclusive) {
    const line = lines[i];
    if (line === undefined || !FENCE_OPEN_RE.test(line.trim())) {
      i += 1;
      continue;
    }

    const contentStart = i + 1; // 0-indexed
    let j = contentStart;
    while (j < bodyEndExclusive && !FENCE_CLOSE_RE.test((lines[j] ?? '').trim())) j += 1;
    const contentEndExclusive = j;

    const contentLines = lines.slice(contentStart, contentEndExclusive);
    const raw = contentLines.join('\n').trim();
    const range: SourceRange = {
      startLine: contentStart + 1,
      endLine: Math.max(contentStart + 1, contentEndExclusive),
    };

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      errors.push({
        section: section.anchor,
        sourceFile: docPath,
        sourceLineRange: range,
        sourceQuote: raw,
        reason: 'invalid-fragment',
        detail: `JSON parse error in \`\`\`align block: ${err instanceof Error ? err.message : String(err)}`,
      });
      i = j + 1;
      continue;
    }

    const result = ruleFragmentSchema.safeParse(parsedJson);
    if (!result.success) {
      errors.push({
        section: section.anchor,
        sourceFile: docPath,
        sourceLineRange: range,
        sourceQuote: raw,
        reason: 'invalid-fragment',
        detail: `Schema validation error: ${result.error.issues.map((iss) => iss.message).join('; ')}`,
      });
      i = j + 1;
      continue;
    }

    fragments.push({ fragment: result.data, sourceLineRange: range, sourceQuote: raw });
    i = j + 1;
  }

  return { fragments, errors };
}
