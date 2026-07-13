/**
 * Tier-2 bullet-grammar reference for `align skill` — reads `@spikedpunch/align-core`'s
 * `BULLET_GRAMMAR_FORMS` catalog (`build/tier2.ts`), which is itself asserted against the real
 * `parseBulletSentence` parser in core's own test suite. This module only renders; it introduces
 * no new grammar knowledge of its own.
 */
import { BULLET_GRAMMAR_FORMS } from '@spikedpunch/align-core';

export function renderBulletGrammarSection(): string {
  const rows = BULLET_GRAMMAR_FORMS.map((form) => `- \`${form.ruleKind}\` — ${form.pattern}\n  e.g. \`- **Rule**: ${form.example}\``);
  return rows.join('\n');
}
