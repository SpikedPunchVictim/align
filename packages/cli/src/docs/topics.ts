/**
 * `align docs` topic registry. Two kinds of topic, deliberately:
 *  - **generated** — delegate to the same live-introspected renderers `align skill` uses (rule
 *    kinds, DSL verbs, gates, CLI inventory, the glob dialect, MCP reference). These can never
 *    drift from the installed binary.
 *  - **doctrine** — curated prose (`config-api.ts`, `conceptual.ts`) for stable concepts that live
 *    only in the root README, which does not ship in the npm package (`files: ["dist"]`). This is
 *    the gap `align docs` closes: version-matched conceptual docs, available offline in any install.
 */
import type { Command } from 'commander';
import { renderRuleKindsSection } from '../skill/rule-kinds.js';
import { renderDslVerbsSection } from '../skill/dsl-verbs.js';
import { renderGatesSection } from '../skill/gates.js';
import { renderCliInventorySection } from '../skill/cli-inventory.js';
import {
  renderComponentSelectorSection,
  renderMcpPayloadReferenceSection,
} from '../skill/static-sections.js';
import { renderConfigApiSection } from './config-api.js';
import * as concept from './conceptual.js';

export interface DocsTopic {
  readonly id: string;
  /** One line shown in the `align docs` index. */
  readonly summary: string;
  /** `program` is only needed by the CLI-inventory renderer; other topics ignore it. */
  readonly render: (program: Command) => string;
}

export const DOCS_TOPICS: readonly DocsTopic[] = [
  { id: 'overview', summary: 'What align is — the oracle thesis and the check→fix→re-check loop', render: () => concept.overview() },
  { id: 'config', summary: 'align.config.ts API — components, rules, excludes, hostRules, telemetry', render: () => renderConfigApiSection() },
  { id: 'selectors', summary: 'Component selector glob dialect (*, **, ?, {a,b,c}, literals)', render: () => renderComponentSelectorSection() },
  { id: 'rules', summary: 'Rule kinds the installed IR supports (generated)', render: () => renderRuleKindsSection() },
  { id: 'verbs', summary: 'DSL verbs — the c.* authoring factories (generated)', render: () => renderDslVerbsSection() },
  { id: 'baseline', summary: 'The baseline — tolerating pre-existing debt with explicit consent', render: () => concept.baseline() },
  { id: 'greenfield', summary: "Greenfield mode — declare architecture before code (empty: 'until-populated')", render: () => concept.greenfield() },
  { id: 'security', summary: 'The security.manifest gate — new / non-registry dependency checks', render: () => concept.security() },
  { id: 'untrusted', summary: 'Untrusted mode — check a repo without executing its config', render: () => concept.untrusted() },
  { id: 'telemetry', summary: 'Telemetry — opt-in, local-only usage log and summary', render: () => concept.telemetry() },
  { id: 'agent', summary: 'The BYOK fix agent — align agent run', render: () => concept.agent() },
  { id: 'mcp', summary: 'MCP server and the align_* tools (generated)', render: () => renderMcpPayloadReferenceSection() },
  { id: 'gates', summary: 'The gate model and priority order (generated)', render: () => renderGatesSection() },
  { id: 'ci', summary: 'CI usage — exit codes, --json, --frozen-rules', render: () => concept.ci() },
  { id: 'trust', summary: 'How align treats trust — fresh scans, false-green doctrine, honest limits', render: () => concept.trust() },
  { id: 'commands', summary: 'Every CLI command (generated live from this binary)', render: (program) => renderCliInventorySection(program) },
];

export function findDocsTopic(id: string): DocsTopic | undefined {
  return DOCS_TOPICS.find((topic) => topic.id === id);
}

/** The no-argument `align docs` output: a cheap, token-economical index (never a full dump). */
export function renderDocsIndex(version: string): string {
  const width = Math.max(...DOCS_TOPICS.map((t) => t.id.length));
  const rows = DOCS_TOPICS.map((t) => `  ${t.id.padEnd(width)}  ${t.summary}`).join('\n');
  return [
    `align ${version} — documentation`,
    '',
    'Print a topic with `align docs <topic>`:',
    '',
    rows,
    '',
    'For the full LLM authoring / fix-loop guide (also written to a skill file with --install),',
    'run `align skill --topic all`.',
  ].join('\n');
}
