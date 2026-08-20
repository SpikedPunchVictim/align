/**
 * ADR 022's headline 0.2.0 transform candidate, paired with `validators/glob-double-star-drift.ts`:
 * "rewrite this selector so its match set is exactly what it was before 0.2.0" (commit 6d6c9c1's
 * interior `**` + `/` whole-segment fix). The rewrite itself, and the proof that it is mechanical rather
 * than a guess, live in `../glob-double-star-shared.ts` (`rewriteInteriorDoubleStar`,
 * `findAffectedGlobDoubleStarSelectors`) — this module is the consent-gated I/O shell around that
 * pure computation: locating the pattern literal in `align.config.ts`, checking the working tree,
 * previewing the diff, and writing it.
 *
 * ## Where this refuses (ADR 022's compensating controls — requirements, not suggestions)
 *
 * - **An unverified rewrite.** `findAffectedGlobDoubleStarSelectors` empirically checks, against
 *   this repo's real scanned files, that the rewritten pattern reproduces the legacy match set
 *   exactly. If it doesn't for even one affected selector, the WHOLE transform refuses — not a
 *   partial write of the selectors that did verify. A wrong mechanical edit applied confidently is
 *   worse than refusing (the task's own framing).
 * - **An unlocatable or ambiguous literal.** The pattern must appear as exactly one string-literal
 *   or no-substitution-template-literal AST NODE (`'...'`, `"..."`, or a backtick literal with no
 *   `${...}` interpolation) in `align.config.ts`'s parsed source — found with the real TypeScript
 *   parser (`typescript`'s `createSourceFile`), not a text search, specifically so a documentation
 *   comment mentioning the same pattern text (a maintainer explaining the selector right above its
 *   declaration, quoted verbatim — exactly what this transform's own fixtures do) is never mistaken
 *   for a second occurrence: comments aren't syntax nodes, so the parser never sees them as
 *   candidates in the first place. Zero
 *   matches (a computed value: template interpolation, string concatenation, a shared constant
 *   referenced by name) or more than one (the identical literal used elsewhere in real code, or
 *   across two components) both refuse — this mirrors `init/marker-block.ts`'s discipline of
 *   throwing rather than guessing which content is the user's, the same discipline that exists
 *   because of BUG #10/#11/#12 (marker-block handling that deleted a user's ruleset when it guessed
 *   wrong about a malformed marker state).
 * - **A dirty working tree, or no git repository at all.** `align.config.ts` is authored,
 *   executable user code; `git checkout` must stay an intact escape hatch before this transform
 *   ever writes to it. A directory that isn't a git repository has no such escape hatch, so it
 *   refuses for the same reason.
 *
 * Refusing is reported in the preview description and is a silent no-op in `apply` (with a
 * console.error naming the reason) — never a partial write, and never a thrown exception `align
 * upgrade`'s `reconcileTransforms` would have to catch.
 *
 * ## Idempotence
 *
 * Once applied, the rewritten pattern no longer contains an interior `**` immediately followed by
 * `/` — the substring `findAffectedGlobDoubleStarSelectors`'s precondition requires — so a second run finds nothing
 * affected and `apply` is a genuine no-op — idempotence falls out of the detection precondition
 * itself rather than needing separate bookkeeping.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { createNodeGitEffects } from '@spikedpunch/align-agent';
import { CONFIG_FILENAME } from '../../config.js';
import { findAffectedGlobDoubleStarSelectors, type AffectedGlobSelector } from '../glob-double-star-shared.js';
import type { Transform, TransformPreview } from '../types.js';
import { writeFileAtomic } from '../../fs-atomic.js';

interface LocatedLiteral {
  /** Index of the literal token's opening quote character. */
  readonly start: number;
  /** Index just past the literal token's closing quote character. */
  readonly end: number;
  readonly quote: string;
}

/** Every string-literal / no-substitution-template-literal AST node in `sourceFile` whose decoded
 * value equals `text` — a real parse, not a text search, so comments and interpolated template
 * expressions are never candidates (see this module's doc comment for why that distinction is the
 * whole point). */
function findStringLiteralNodes(sourceFile: ts.SourceFile, text: string): readonly ts.Node[] {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === text) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

/** Finds `literal` as an unambiguous string/template-literal AST node in `source`. Returns the
 * single match when there's exactly one, `'not-found'` for zero, `'ambiguous'` for more than one —
 * the transform refuses on either of the latter two rather than guess which occurrence (if any) is
 * the selector it means to rewrite. */
function locateLiteral(source: string, literal: string): LocatedLiteral | 'ambiguous' | 'not-found' {
  const sourceFile = ts.createSourceFile(CONFIG_FILENAME, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const matches = findStringLiteralNodes(sourceFile, literal);
  if (matches.length === 0) return 'not-found';
  if (matches.length > 1) return 'ambiguous';
  const node = matches[0];
  if (node === undefined) return 'not-found';
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const quote = source[start] ?? "'";
  return { start, end, quote };
}

interface LocatedEdit {
  readonly selector: AffectedGlobSelector;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

type Plan =
  | { readonly kind: 'nothing-to-do' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'ready'; readonly configPath: string; readonly source: string; readonly edits: readonly LocatedEdit[] };

/** The single source of truth both `preview` and `apply` compute from — see this module's doc
 * comment. Read-only: does not write anything, including when it decides to refuse. */
async function computePlan(rootDir: string): Promise<Plan> {
  const affected = await findAffectedGlobDoubleStarSelectors(rootDir);
  if (affected.length === 0) return { kind: 'nothing-to-do' };

  const unverified = affected.find((a) => !a.verifiedRewrite);
  if (unverified !== undefined) {
    return {
      kind: 'refused',
      reason:
        `could not verify a safe rewrite for component '${unverified.component}' selector '${unverified.pattern}' — ` +
        "the rewritten pattern did not reproduce the exact legacy match set against this repo's current files. " +
        'Refusing rather than guess.',
    };
  }

  const configPath = path.join(rootDir, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    return { kind: 'refused', reason: `${CONFIG_FILENAME} not found.` };
  }
  const source = fs.readFileSync(configPath, 'utf8');

  const editsByStart = new Map<number, LocatedEdit>();
  for (const selector of affected) {
    const located = locateLiteral(source, selector.pattern);
    if (located === 'not-found') {
      return {
        kind: 'refused',
        reason:
          `could not locate the exact string literal '${selector.pattern}' (component '${selector.component}') in ` +
          `${CONFIG_FILENAME} — it may be computed rather than a plain string literal. Refusing rather than guess.`,
      };
    }
    if (located === 'ambiguous') {
      return {
        kind: 'refused',
        reason:
          `'${selector.pattern}' (component '${selector.component}') appears more than once as a string literal in ` +
          `${CONFIG_FILENAME} — refusing rather than guess which occurrence to rewrite.`,
      };
    }
    editsByStart.set(located.start, { selector, start: located.start, end: located.end, quote: located.quote });
  }

  // ADR 022 compensating controls: refuse on a dirty working tree (or no git repo at all — `.catch`
  // maps a `git status` failure, e.g. "not a git repository", to the same refusal) so `git
  // checkout` is always an intact escape hatch before this transform ever writes.
  const clean = await createNodeGitEffects(rootDir)
    .isWorktreeClean()
    .catch(() => false);
  if (!clean) {
    return {
      kind: 'refused',
      reason:
        `refusing to rewrite ${CONFIG_FILENAME} — the working tree is dirty (or is not a git repository), so ` +
        '`git checkout` would not be an intact escape hatch if this edit turned out to be wrong.',
    };
  }

  // Descending start-offset order: replacing the highest offset first leaves every lower,
  // not-yet-applied offset still valid, since nothing before it in the string has moved.
  const edits = [...editsByStart.values()].sort((a, b) => b.start - a.start);
  return { kind: 'ready', configPath, source, edits };
}

function describePlan(plan: Plan): TransformPreview {
  if (plan.kind === 'nothing-to-do') {
    return { status: 'nothing-to-do', description: 'No affected selectors found — nothing to rewrite.', filesAffected: [] };
  }
  if (plan.kind === 'refused') {
    return { status: 'refused', description: `Refusing: ${plan.reason}`, filesAffected: [] };
  }
  const lines = [...plan.edits]
    .sort((a, b) => a.start - b.start)
    .map((e) => `  component '${e.selector.component}': '${e.selector.pattern}' -> '${e.selector.rewritten}'`);
  return {
    status: 'ready',
    description: `Rewrite ${plan.edits.length} selector(s) in ${CONFIG_FILENAME} to reproduce their pre-0.2.0 match set:\n${lines.join('\n')}`,
    filesAffected: [CONFIG_FILENAME],
  };
}

function applyEdits(plan: Extract<Plan, { kind: 'ready' }>): string {
  let next = plan.source;
  for (const edit of plan.edits) {
    const replacement = `${edit.quote}${edit.selector.rewritten}${edit.quote}`;
    next = next.slice(0, edit.start) + replacement + next.slice(edit.end);
  }
  return next;
}

export const globDoubleStarSelectorRewriteTransform: Transform = {
  id: 'glob-double-star-selector-rewrite',
  description:
    "Rewrites a component selector's interior `**/` so the current whole-segment `**` engine matches exactly what " +
    'the pre-0.2.0 cross-segment engine matched (commit 6d6c9c1).',
  idempotent: true,

  async preview(rootDir: string): Promise<TransformPreview> {
    return describePlan(await computePlan(rootDir));
  },

  async apply(rootDir: string): Promise<void> {
    const plan = await computePlan(rootDir);
    if (plan.kind !== 'ready') {
      const reason = plan.kind === 'refused' ? plan.reason : 'nothing to do';
      console.error(`align upgrade: transform 'glob-double-star-selector-rewrite' did not apply — ${reason}.`);
      return;
    }
    writeFileAtomic(plan.configPath, applyEdits(plan));
  },
};
