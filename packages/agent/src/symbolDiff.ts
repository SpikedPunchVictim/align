/**
 * Exported-symbol surface diff (green≠correct guard (a), IMPLEMENTATION_PLAN.md Stage 4): a
 * deletion of an exported symbol across a fix becomes an escalating advisory requiring explicit
 * consent (`--allow-symbol-removals`) rather than a silent commit — the cheapest fix for "forbidden
 * import" is often deleting the import AND the feature that used it, which every form gate would
 * happily call green.
 */
import type { RepoRelativePath } from '@align/core';
import type { SymbolTableEntry } from './fixProvider.js';

export interface SymbolRemoval {
  readonly file: RepoRelativePath;
  readonly removedSymbols: readonly string[];
}

/** Pure diff: exports present before a fix but absent after, per file. */
export function diffExportedSymbols(
  before: readonly SymbolTableEntry[],
  after: readonly SymbolTableEntry[],
): readonly SymbolRemoval[] {
  const afterByFile = new Map(after.map((e) => [e.file, new Set(e.exports)]));
  const removals: SymbolRemoval[] = [];
  for (const beforeEntry of before) {
    const afterExports = afterByFile.get(beforeEntry.file);
    const removedSymbols = beforeEntry.exports.filter((sym) => !(afterExports?.has(sym) ?? false));
    if (removedSymbols.length > 0) removals.push({ file: beforeEntry.file, removedSymbols });
  }
  return removals;
}
