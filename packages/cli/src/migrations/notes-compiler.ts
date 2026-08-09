/**
 * Compiles `UPGRADING.md`'s version-keyed sections into per-version migration notes (ADR 022's
 * "Notes" tier, ADR 011's doc-is-source pattern applied here). A structural transform ONLY: this
 * turns markdown headings into data — it never invents, rewrites, or summarizes the authored prose
 * itself (ADR 022: "align never generates migration prose from a diff — it selects and assembles
 * authored text"). Reuses `parseMarkdownDoc`/`sha256Hex` from `@spikedpunch/align-core` (the same
 * section model and hashing utility `align build`'s own doc-source pipeline uses) rather than
 * inventing a second markdown parser or a second hashing scheme.
 *
 * This function's output is meant to be computed once, by `scripts/compile-upgrading-notes.mjs`,
 * and written into the checked-in `notes.generated.ts` that ships in the published package —
 * `UPGRADING.md` itself is not published (see that generated file's doc comment for why). Nothing
 * in the shipped CLI calls this function at runtime; it exists so the compile step is tested code,
 * not a one-off script nobody can verify.
 *
 * Document shape this function requires:
 *   - Every `##` (level-2) heading is a version section, and its heading text must be a bare
 *     semver (`0.1.4`, not "0.1.4 (unreleased)" or "Unreleased") — anything else is a loud error,
 *     never silently skipped, so a typo'd or forward-dated heading fails the build instead of
 *     quietly compiling to nothing.
 *   - Two version sections may not share the same heading text — a loud error, not a silent merge.
 *   - Every `###` (level-3) heading inside a version section becomes one `MigrationNote`
 *     (`heading` + `body`, its own text verbatim, trimmed). A version section legitimately may have
 *     zero notes at the STRUCTURAL level — that is a content-completeness question, enforced
 *     separately by `registry.ts`'s `hasNotesForVersion`, not a parse error here.
 *   - A `###` heading that does not fall under any `##` version section (before the first one, or
 *     after the last section's own end) is an orphan and is also a loud error.
 *   - Nothing may nest deeper than `###` — a loud error, not content silently folded into its
 *     parent's body.
 */
import { parseMarkdownDoc, sha256Hex } from '@spikedpunch/align-core';
import type { MigrationNote } from './types.js';

const VERSION_HEADING_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface CompiledNotes {
  readonly notesByVersion: Readonly<Record<string, readonly MigrationNote[]>>;
  /** `sha256Hex` of the exact doc text compiled — the drift-detection anchor, same content-hash
   * function `align build`'s `rules.lock.json` uses for `docContentHash` (ADR 011). */
  readonly contentHash: string;
}

export function compileUpgradingNotes(docText: string): CompiledNotes {
  const { sections } = parseMarkdownDoc(docText);

  for (const section of sections) {
    if (section.level > 3) {
      throw new Error(
        `Malformed UPGRADING.md: "${'#'.repeat(section.level)} ${section.headingText}" (line ${section.startLine}) is ` +
          `nested deeper than this compiler supports. Notes are exactly two levels deep: "## <version>" then "### <note heading>".`,
      );
    }
  }

  const versionSections = sections.filter((s) => s.level === 2);
  const seenVersions = new Set<string>();
  const notesByVersion: Record<string, MigrationNote[]> = {};
  const usedNoteLines = new Set<number>();

  versionSections.forEach((versionSection, i) => {
    if (!VERSION_HEADING_RE.test(versionSection.headingText)) {
      throw new Error(
        `Malformed UPGRADING.md: "## ${versionSection.headingText}" (line ${versionSection.startLine}) is not a ` +
          `version heading. Every "##" section must be a bare version (e.g. "## 0.1.4") so the notes compiler can ` +
          `key it to a release.`,
      );
    }
    if (seenVersions.has(versionSection.headingText)) {
      throw new Error(
        `Malformed UPGRADING.md: duplicate version section "## ${versionSection.headingText}" (line ${versionSection.startLine}).`,
      );
    }
    seenVersions.add(versionSection.headingText);

    const nextVersionSection = versionSections[i + 1];
    const rangeEnd = nextVersionSection === undefined ? Number.POSITIVE_INFINITY : nextVersionSection.startLine;
    const noteSections = sections.filter(
      (s) => s.level === 3 && s.startLine > versionSection.startLine && s.startLine < rangeEnd,
    );
    for (const s of noteSections) usedNoteLines.add(s.startLine);

    notesByVersion[versionSection.headingText] = noteSections.map((s) => ({
      heading: s.headingText,
      body: s.bodyText.trim(),
    }));
  });

  const orphan = sections.find((s) => s.level === 3 && !usedNoteLines.has(s.startLine));
  if (orphan !== undefined) {
    throw new Error(
      `Malformed UPGRADING.md: "### ${orphan.headingText}" (line ${orphan.startLine}) is not inside any "##" version section.`,
    );
  }

  return { notesByVersion, contentHash: sha256Hex(docText) };
}
