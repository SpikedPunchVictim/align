/**
 * Safety-rail pure checks (IMPLEMENTATION_PLAN.md Stage 4 "Safety rails"). Kept separate from the
 * git/fs imperative shell so every rail is independently unit-testable with plain data.
 */
import type { RepoRelativePath } from '@spikedpunch/align-core';
import type { FixProposal } from '@spikedpunch/align-core';

const FORBIDDEN_PATH_PREFIXES = ['.align/', '.align'] as const;
const FORBIDDEN_EXACT_FILES = ['align.config.ts'] as const;

/** True if `rawPath` (as proposed by the LLM, not yet branded) targets `align.config.ts`,
 * anything under `.align/`, or escapes the repo root (`..` traversal / absolute path). */
export function isForbiddenPath(rawPath: string): boolean {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized.startsWith('..')) return true;
  if (FORBIDDEN_EXACT_FILES.includes(normalized as (typeof FORBIDDEN_EXACT_FILES)[number])) return true;
  return FORBIDDEN_PATH_PREFIXES.some((prefix) => normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix));
}

export interface ForbiddenPathViolation {
  readonly path: string;
}

/** Reject any `FixProposal` touching a forbidden path — checked BEFORE the apply pipeline ever
 * runs, so a proposal that reaches for `align.config.ts` never gets a chance to validate an edit
 * block against it. */
export function findForbiddenPathsInProposal(proposal: FixProposal): readonly ForbiddenPathViolation[] {
  return proposal.files.filter((f) => isForbiddenPath(f.path)).map((f) => ({ path: f.path }));
}

/** Suppressions are dormant machinery in arch-first v1 (ADR 010/012): no lint gates exist yet, so
 * no rule category is suppressible. Any proposal that uses `suppressions` is rejected outright —
 * tested as such; see the agent package README for the one-paragraph explanation. */
export function usesSuppressions(proposal: FixProposal): boolean {
  return (proposal.suppressions?.length ?? 0) > 0;
}

export type GroupFile = { readonly file: RepoRelativePath };

/** Group violations by file — GROUP step (ADR 010/plan: "all of a file's violations in one
 * prompt"). Pure, deterministic ordering (first-seen file order, stable). */
export function groupViolationsByFile<V extends GroupFile>(violations: readonly V[]): ReadonlyMap<RepoRelativePath, readonly V[]> {
  const groups = new Map<RepoRelativePath, V[]>();
  for (const v of violations) {
    const list = groups.get(v.file);
    if (list === undefined) groups.set(v.file, [v]);
    else list.push(v);
  }
  return groups;
}
