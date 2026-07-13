/**
 * DSL verb table for `align skill` — reads `@spikedpunch/align-core/dsl`'s runtime-introspected verb manifest
 * (`dsl/verb-manifest.ts`) rather than hand-typing the builder surface a second time.
 */
import { describeDslVerbs } from '@spikedpunch/align-core/dsl';

export function renderDslVerbsSection(): string {
  const rows = describeDslVerbs().map(
    (verb) => `| \`${verb.path}\` | ${verb.description} | ${verb.producesRuleKind.map((k) => `\`${k}\``).join(', ')} |`,
  );
  return ['| Verb | Meaning | Produces |', '| --- | --- | --- |', ...rows].join('\n');
}
