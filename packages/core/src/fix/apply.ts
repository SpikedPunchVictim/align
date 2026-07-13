/**
 * Edit-block apply pipeline — engine half (ADR 010).
 *
 * Pure functions only (CODING_BEST_PRACTICES.md §14): given immutable original text and a set of
 * proposed edit blocks, decide whether the edits apply and what the resulting text is. No I/O —
 * callers (in `@spikedpunch/align-agent`) are responsible for reading the original file and writing the
 * result. This keeps the algorithm trivially unit-testable with plain strings.
 *
 * Algorithm (ADR 010):
 *   1. Scan the immutable original text for the unique starting offset of every `search` block —
 *      literal character-for-character string matching, no line numbers.
 *   2. Multi-match: use `nearLine` to pick the closest match (line-distance) instead of rejecting.
 *   3. Reject atomically: 0 matches, unresolved ambiguity (>1 match, no `nearLine` to
 *      disambiguate, or a tie), or any two validated spans overlapping -> zero edits applied to
 *      the file. The failure carries `FailureContext` with ±3-line, line-numbered context of the
 *      nearest candidate region (LLM's eyes only — never fed back into the engine's search).
 *   4. Sort validated edits descending by original offset and apply sequentially, so edits at the
 *      end of the file never shift the coordinates of earlier edits.
 *
 * No fuzzy/whitespace-normalized fallback (Design Reserve — IMPLEMENTATION_PLAN.md).
 */
import type { RepoRelativePath } from '../types/branded.js';
import type { EditBlock, FixProposalFile } from './schema.js';

export interface ValidatedEdit {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly replacement: string;
}

export type FailureReason = 'zero-matches' | 'ambiguous-matches' | 'overlapping-spans';

export interface FailureContext {
  readonly file: RepoRelativePath;
  readonly reason: FailureReason;
  readonly nearestCandidate?: {
    readonly linesWithContext: string;
    readonly startLine: number;
  };
}

export type FileApplyResult =
  | { readonly ok: true; readonly content: string; readonly editCount: number }
  | { readonly ok: false; readonly failure: FailureContext };

/** All non-overlapping literal occurrences of `search` in `text`, in ascending offset order. */
function findAllOccurrences(text: string, search: string): number[] {
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const idx = text.indexOf(search, from);
    if (idx === -1) break;
    offsets.push(idx);
    from = idx + Math.max(search.length, 1);
  }
  return offsets;
}

/** 1-based line number containing `offset`. */
function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** ±3-line, line-numbered context window around `centerOffset`, for the LLM's eyes only. */
function contextAround(text: string, centerOffset: number): { linesWithContext: string; startLine: number } {
  const starts = lineStartOffsets(text);
  const lines = text.split('\n');
  const centerLine = lineNumberAt(text, centerOffset); // 1-based
  const startLine = Math.max(1, centerLine - 3);
  const endLine = Math.min(lines.length, centerLine + 3);
  const windowLines: string[] = [];
  for (let ln = startLine; ln <= endLine; ln++) {
    windowLines.push(`${ln}: ${lines[ln - 1] ?? ''}`);
  }
  void starts;
  return { linesWithContext: windowLines.join('\n'), startLine };
}

/** Best-effort nearest-candidate region when a search block has zero exact matches. */
function nearestCandidateForZeroMatches(
  text: string,
  search: string,
): { linesWithContext: string; startLine: number } | undefined {
  const searchLines = search.split('\n').filter((l) => l.trim().length > 0);
  for (const candidateLine of searchLines) {
    const idx = text.indexOf(candidateLine);
    if (idx !== -1) return contextAround(text, idx);
  }
  return undefined;
}

interface ResolvedEdit {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly replacement: string;
}

type ResolveResult = { readonly ok: true; readonly edit: ResolvedEdit } | { readonly ok: false; readonly failure: FailureContext };

function resolveEdit(text: string, file: RepoRelativePath, edit: EditBlock): ResolveResult {
  const matches = findAllOccurrences(text, edit.search);

  if (matches.length === 0) {
    const nearestCandidate = nearestCandidateForZeroMatches(text, edit.search);
    return {
      ok: false,
      failure:
        nearestCandidate === undefined
          ? { file, reason: 'zero-matches' }
          : { file, reason: 'zero-matches', nearestCandidate },
    };
  }

  if (matches.length === 1) {
    const start = matches[0] as number;
    return { ok: true, edit: { startOffset: start, endOffset: start + edit.search.length, replacement: edit.replace } };
  }

  // Multiple matches — nearLine disambiguates by picking the closest, deterministically.
  if (edit.nearLine === undefined) {
    return {
      ok: false,
      failure: {
        file,
        reason: 'ambiguous-matches',
        nearestCandidate: contextAround(text, matches[0] as number),
      },
    };
  }

  let best: { offset: number; distance: number } | undefined;
  let tie = false;
  for (const offset of matches) {
    const distance = Math.abs(lineNumberAt(text, offset) - edit.nearLine);
    if (best === undefined || distance < best.distance) {
      best = { offset, distance };
      tie = false;
    } else if (distance === best.distance) {
      tie = true;
    }
  }
  if (best === undefined) {
    // unreachable (matches.length > 1 implies a best exists), satisfies strict null checks
    return {
      ok: false,
      failure: { file, reason: 'ambiguous-matches', nearestCandidate: contextAround(text, matches[0] as number) },
    };
  }
  if (tie) {
    return {
      ok: false,
      failure: { file, reason: 'ambiguous-matches', nearestCandidate: contextAround(text, best.offset) },
    };
  }

  return {
    ok: true,
    edit: { startOffset: best.offset, endOffset: best.offset + edit.search.length, replacement: edit.replace },
  };
}

function spansOverlap(a: ResolvedEdit, b: ResolvedEdit): boolean {
  return a.startOffset < b.endOffset && b.startOffset < a.endOffset;
}

/**
 * Validate and apply every edit block for a single file against its immutable original text.
 * Rejects the ENTIRE file patch atomically on any failure — matches ADR 010's pure-function
 * memoization semantics (a proposal either fully applies or fully doesn't).
 */
export function applyEditsToFile(originalText: string, file: RepoRelativePath, edits: readonly EditBlock[]): FileApplyResult {
  const resolved: ResolvedEdit[] = [];
  for (const edit of edits) {
    const result = resolveEdit(originalText, file, edit);
    if (!result.ok) return { ok: false, failure: result.failure };
    resolved.push(result.edit);
  }

  // Overlap check across ALL edits in the file (sorted first for a simple adjacent-pair scan).
  const bySpan = [...resolved].sort((a, b) => a.startOffset - b.startOffset);
  for (let i = 1; i < bySpan.length; i++) {
    const prev = bySpan[i - 1] as ResolvedEdit;
    const curr = bySpan[i] as ResolvedEdit;
    if (spansOverlap(prev, curr)) {
      return {
        ok: false,
        failure: { file, reason: 'overlapping-spans', nearestCandidate: contextAround(originalText, curr.startOffset) },
      };
    }
  }

  // Sort descending by offset and apply sequentially — later edits never shift earlier offsets.
  const descending = [...resolved].sort((a, b) => b.startOffset - a.startOffset);
  let content = originalText;
  for (const edit of descending) {
    content = content.slice(0, edit.startOffset) + edit.replacement + content.slice(edit.endOffset);
  }

  return { ok: true, content, editCount: resolved.length };
}

export type ValidatedFile = { readonly path: RepoRelativePath } & (
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly failure: FailureContext }
);

/**
 * Apply every file's edits in a `FixProposal`. Each file is validated/applied independently and
 * atomically — one file's failure does not block another file's success, but any single failure
 * means that ONE file's patch was fully rejected (zero edits from it applied).
 */
export function applyFixProposalFiles(
  originalContents: ReadonlyMap<RepoRelativePath, string>,
  files: readonly FixProposalFile[],
  toPath: (raw: string) => RepoRelativePath,
): readonly ValidatedFile[] {
  return files.map((f) => {
    const path = toPath(f.path);
    const original = originalContents.get(path);
    if (original === undefined) {
      return { path, ok: false, failure: { file: path, reason: 'zero-matches' as const } };
    }
    const result = applyEditsToFile(original, path, f.edits);
    return result.ok ? { path, ok: true, content: result.content } : { path, ok: false, failure: result.failure };
  });
}
