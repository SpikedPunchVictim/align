/**
 * `align docs config` — the align.config.ts authoring API. Prose (stable structural API, doesn't
 * version-drift the way the rule-kind/verb tables do — those are generated; see `align docs verbs`
 * / `rules`). Grounded in `@spikedpunch/align-core`'s `defineProject` / `ComponentDeclaration`.
 */
export function renderConfigApiSection(): string {
  return `\`align.config.ts\` is a TypeScript module with one **default export** and three optional **named exports**.

## Default export: \`defineProject({ components, rules })\`

\`\`\`ts
import { defineProject } from '@spikedpunch/align-core/dsl';

export default defineProject({
  components: { core: 'packages/core/**', cli: 'packages/cli/**' },
  rules: (c) => [
    c.arch.noCycles(),
    c.arch.layer(c.core).cannotDependOn(c.cli).because('core is the base layer; nothing above may claim it.'),
  ],
});
\`\`\`

## \`components\` (required)

A map of stable component name → file selector. A selector is one of:

- a **glob string** — \`'packages/core/**'\` (dialect: \`*\`, \`**\`, \`?\`, \`{a,b,c}\`, literals — run \`align docs selectors\`);
- a **package selector** — \`'package:@scope/name'\`, resolved against the workspace inventory (pnpm/npm/yarn/bun);
- an **object with an empty policy** — \`{ pattern: 'src/core/**', empty: 'until-populated' }\`.

\`empty\` is \`'fail'\` (default — a zero-match selector is a load error, the anti-stale-glob guard), \`'allow'\` (permanently optional), or \`'until-populated'\` (greenfield — auto-arms once files land; \`align docs greenfield\`). Component names become typed \`c.<name>\` references in \`rules\` — a reference to a name that doesn't exist is a TypeScript compile error, not a silent no-op at check time.

## \`rules\` (optional): \`(c) => RuleBuilder[]\`

\`c\` is a typed context carrying one reference per component plus the rule factories \`c.arch.*\`, \`c.security.*\`, and \`c.custom.host(name)\`. Each factory returns a builder; end any rule with \`.because('…')\` to attach provenance that \`align explain <ruleId>\` surfaces later. Run \`align docs verbs\` for the full factory list and \`align docs rules\` for the rule kinds — both generated live from the installed binary.

## Named exports (all optional)

- \`export const excludes: string[]\` — repo-relative path prefixes omitted from the scan (e.g. \`['test-apps', 'docs/evidence']\`). Scan-time only; not part of the portable IR.
- \`export const hostRules: Record<string, HostPredicate>\` — pure functions over the dependency graph, referenced by \`c.custom.host('name')\`. Registration is checked: a \`custom.host\` rule with no matching predicate reports \`error\`, never a silent pass.
- \`export const telemetry: boolean\` — opt into local-only usage logging (equivalently \`ALIGN_TELEMETRY=1\` / \`--telemetry\`; \`align docs telemetry\`).

## Loading & trust

\`align check\` **executes** this file (Node strips TS types natively — keep it *erasable* TS: interfaces and type annotations, no enums or parameter-properties). It must resolve \`@spikedpunch/align-core\`, so run it in a repo where that is a devDependency — \`pnpm create @spikedpunch/align\` sets this up. For a repo you don't trust, \`align export-ir\` writes a function-free JSON snapshot that \`align check --untrusted\` evaluates without ever importing this file (\`align docs untrusted\`).`;
}
