/**
 * Shared marker-splice logic for align's idempotent generated-block writers (`claude-md.ts`'s
 * `writeAgentInstructions`, `config-comment.ts`'s `writeGeneratedRulesNote`): both wrap an
 * align-owned block in a human-editable file between a START and END marker, and must splice that
 * block back in place on re-run without ever guessing which surrounding content is the human's.
 *
 * The two states that are unambiguous: zero markers of both kinds (no block yet — append), or
 * exactly one of each in START-before-END order (splice between them). Every other arrangement
 * (an orphan START or END, END before START, or more than one pair) is refused with a descriptive
 * error rather than resolved by `indexOf`-locating "the first" of each — `indexOf` alone can't
 * distinguish a genuine single pair from those malformed shapes, and guessing wrong there either
 * silently deletes human content or duplicates the block forever (bug hunt 2026-08-03, BUG
 * #10/#11/#12).
 */

function occurrences(s: string, marker: string): number {
  return s.split(marker).length - 1;
}

/**
 * Returns the splice bounds for exactly one well-formed START…END pair, `undefined` when the file
 * has no block yet (caller should append), and throws on any other marker arrangement — align
 * must never guess which content is the human's.
 */
export function locateBlock(
  existing: string,
  filePath: string,
  startMarker: string,
  endMarker: string,
): { readonly start: number; readonly end: number } | undefined {
  const starts = occurrences(existing, startMarker);
  const ends = occurrences(existing, endMarker);
  if (starts === 0 && ends === 0) return undefined;
  if (starts === 1 && ends === 1) {
    const start = existing.indexOf(startMarker);
    const end = existing.indexOf(endMarker);
    if (end > start) return { start, end };
  }
  throw new Error(
    `${filePath} has a malformed align block: ${starts} \`${startMarker}\` and ${ends} ` +
      `\`${endMarker}\` marker(s). align refuses to rewrite the file rather than guess which ` +
      `content is yours. Restore exactly one START…END pair, or delete both markers to let align ` +
      `append a fresh block, then re-run.`,
  );
}

/**
 * Splices `newBlock` into `existing` in place of the located block, or appends it (with a
 * blank-line separator that matches the file's existing trailing-newline style) when there's no
 * block yet. Throws — via `locateBlock` — on any malformed marker arrangement, leaving `existing`
 * untouched by the caller (nothing is written before this returns).
 */
export function spliceOrAppendBlock(existing: string, newBlock: string, filePath: string, startMarker: string, endMarker: string): string {
  const located = locateBlock(existing, filePath, startMarker, endMarker);
  if (located === undefined) {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    return `${existing}${separator}${newBlock}\n`;
  }
  const before = existing.slice(0, located.start);
  const after = existing.slice(located.end + endMarker.length);
  return `${before}${newBlock}${after}`;
}

/**
 * Validation-only wrapper around `locateBlock`: throws on a malformed marker arrangement, returns
 * nothing otherwise. Intended as a pre-flight check — call this on every file a multi-step write
 * sequence touches, before any of those steps writes anything, so a malformed marker state fails
 * the whole sequence atomically instead of surfacing mid-sequence after some artifacts are already
 * on disk (bug hunt 2026-08-03, BUG #10/#11/#12's reachability inside `writeBuildArtifacts`).
 */
export function assertBlockWellFormed(existing: string, filePath: string, startMarker: string, endMarker: string): void {
  locateBlock(existing, filePath, startMarker, endMarker);
}
