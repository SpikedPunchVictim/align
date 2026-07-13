/**
 * DSL verb table for `align skill` — reads `@align/core/dsl`'s runtime-introspected verb manifest
 * (`dsl/verb-manifest.ts`) rather than hand-typing the builder surface a second time.
 */
import { describeDslVerbs } from '@align/core/dsl';

export function renderDslVerbsSection(): string {
  const rows = describeDslVerbs().map(
    (verb) => `| \`${verb.path}\` | ${verb.description} | ${verb.producesRuleKind.map((k) => `\`${k}\``).join(', ')} |`,
  );
  return ['| Verb | Meaning | Produces |', '| --- | --- | --- |', ...rows].join('\n');
}
