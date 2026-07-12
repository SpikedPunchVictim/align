import { sha256Hex } from './hash.js';

/**
 * Markdown section model (ADR 011): a doc is parsed into heading-anchored sections with stable
 * content hashes. Every markdown heading (any level, `#`-`######`) starts a new section that runs
 * until the next heading or end of file — a flat model, not a nested tree; `align build`'s
 * change-detection unit is "the section under one heading," which is what ADR 011's acceptance
 * criteria ("one-section reword re-proposes only that section") operates on.
 */
export interface DocSection {
  /** Stable slug derived from the heading text (github-style), deduped against earlier headings
   * in the same doc so two identically-worded headings don't collide. */
  readonly anchor: string;
  readonly headingText: string;
  readonly level: number;
  /** 1-based, inclusive — the heading line itself. */
  readonly startLine: number;
  /** 1-based, inclusive — the last line of the section's body (before the next heading, or EOF). */
  readonly endLine: number;
  /** Raw body text (excludes the heading line) — the classification/hashing input. */
  readonly bodyText: string;
  /** Content hash of `headingText` + `bodyText` — changes iff the section's own text changes,
   * independent of line-number shifts caused by edits elsewhere in the doc. */
  readonly contentHash: string;
}

export interface ParsedDoc {
  readonly lines: readonly string[];
  readonly sections: readonly DocSection[];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

function slugify(headingText: string): string {
  const base = headingText
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base.length > 0 ? base : 'section';
}

function dedupeAnchor(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

/** Parses a markdown document into heading-anchored sections (ADR 011). Pure — no I/O. */
export function parseMarkdownDoc(doc: string): ParsedDoc {
  const lines = doc.split('\n');
  const seenAnchors = new Map<string, number>();

  interface RawHeading {
    readonly level: number;
    readonly headingText: string;
    readonly startLine: number;
  }
  const headings: RawHeading[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = HEADING_RE.exec(line);
    if (match === null) continue;
    const hashes = match[1];
    const headingText = match[2];
    if (hashes === undefined || headingText === undefined) continue;
    headings.push({ level: hashes.length, headingText, startLine: i + 1 });
  }

  const sections: DocSection[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const h = headings[i];
    if (h === undefined) continue;
    const next = headings[i + 1];
    const endLine = next === undefined ? lines.length : next.startLine - 1;
    const bodyLines = lines.slice(h.startLine, endLine); // excludes the heading line itself
    const bodyText = bodyLines.join('\n');
    const anchor = dedupeAnchor(slugify(h.headingText), seenAnchors);
    sections.push({
      anchor,
      headingText: h.headingText,
      level: h.level,
      startLine: h.startLine,
      endLine,
      bodyText,
      contentHash: sha256Hex(`${h.headingText}\n${bodyText}`),
    });
  }

  return { lines, sections };
}
