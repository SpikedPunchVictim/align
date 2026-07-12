import type { RepoRelativePath } from '../types/branded.js';
import type { RuleProvenance } from '../types/ir.js';
import type { SourceRange } from '../types/violation.js';

/**
 * Renders the "Enforced by <file>:<lines>: '<quote>'" phrase every doc-built violation message
 * carries (ADR 011's acceptance criterion, `IMPLEMENTATION_PLAN.md` Stage 4 goal text). Single
 * line ranges render as `N`, not `N-N`.
 */
export function renderEnforcedBy(sourceFile: RepoRelativePath, range: SourceRange, quote: string): string {
  const lines = range.startLine === range.endLine ? `${range.startLine}` : `${range.startLine}-${range.endLine}`;
  return `Enforced by ${sourceFile}:${lines}: '${quote}'`;
}

/**
 * Builds a doc-built rule's `RuleProvenance` block (ADR 011, `docs/ir-schema.md`). `.because()`
 * and `sourceQuote` converge on the same terminal-output field (ADR 011 Consequences) — `because`
 * is auto-populated from the "Enforced by..." phrase; an author-supplied override (a tier-1
 * fragment's `because` field, or a hand-written `.because()` on a rule align build later merges
 * with — see `merge.ts`) is prepended rather than replacing it, so provenance is never silently
 * lost.
 */
export function buildProvenance(
  sourceFile: RepoRelativePath,
  sourceLineRange: SourceRange,
  sourceQuote: string,
  authorBecause?: string,
): RuleProvenance {
  const enforcedBy = renderEnforcedBy(sourceFile, sourceLineRange, sourceQuote);
  const because = authorBecause === undefined ? enforcedBy : `${authorBecause} ${enforcedBy}`;
  return { because, sourceFile, sourceLineRange, sourceQuote };
}
