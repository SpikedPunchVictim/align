/**
 * Human-readable rendering for `align build` (ADR 011) — split out of `build.ts` (which owns the
 * dry-run/apply/verify pipeline itself) purely for `arch.metric:loc:cli`'s max-500-lines-per-file
 * limit: this is presentation logic with no pipeline state of its own, a clean single-
 * responsibility seam, not code moved just to dodge the metric.
 */
import { renderViolationMessage } from '@spikedpunch/align-core';
import type { DryRunResult } from './build.js';

export function renderBuildReport(result: DryRunResult): string {
  const lines: string[] = [
    `# align build report`,
    ``,
    `Doc: \`${result.docRelPath}\` (${result.docContentHash})`,
    `Built: ${new Date().toISOString()}`,
    ``,
    `## Impact`,
    ``,
    `- Adds ${result.impact.addedNew.length} new violation(s)`,
    `- Masks ${result.impact.maskedBaselined.length} previously-baselined violation(s)`,
    ``,
    `## Rules`,
    ``,
  ];

  for (const rule of result.proposal.rules) {
    const quote = rule.provenance.sourceQuote ?? '';
    const range = rule.provenance.sourceLineRange;
    const lineRef = range === undefined ? '' : `:${range.startLine}${range.endLine !== range.startLine ? `-${range.endLine}` : ''}`;
    lines.push(`### \`${rule.id}\``);
    lines.push('');
    lines.push(`- Source: \`${rule.provenance.sourceFile ?? result.docRelPath}${lineRef}\``);
    lines.push(`- Quote: "${quote}"`);
    lines.push(`- IR: \`${JSON.stringify({ kind: rule.kind, ...ruleSelectors(rule) })}\``);
    lines.push('');
  }

  if (result.proposal.flagged.length > 0) {
    lines.push(`## Flagged (not written)`, '');
    for (const f of result.proposal.flagged) {
      lines.push(`- **${f.reason}** (\`${f.section}\`, ${f.sourceFile}:${f.sourceLineRange.startLine}): ${f.detail}`);
    }
    lines.push('');
  }

  if (result.diff.added.length + result.diff.changed.length + result.diff.removed.length > 0) {
    lines.push(`## Diff vs. previous generated-rules.json`, '');
    for (const r of result.diff.added) lines.push(`- + added \`${r.id}\``);
    for (const c of result.diff.changed) lines.push(`- ~ changed \`${c.after.id}\``);
    for (const r of result.diff.removed) lines.push(`- - removed \`${r.id}\``);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function ruleSelectors(rule: DryRunResult['proposal']['rules'][number]): Record<string, unknown> {
  switch (rule.kind) {
    case 'arch.no-dependency':
      return { from: rule.from, to: rule.to };
    case 'arch.no-cycles':
      return { scope: rule.scope, includeTypeOnly: rule.includeTypeOnly };
    case 'arch.layers':
      return { layers: rule.layers };
    case 'custom.host':
      return { hostRuleName: rule.hostRuleName };
    case 'arch.metric':
      return { target: rule.target, metric: rule.metric, max: rule.max };
    case 'security.manifest.source-hygiene':
    case 'security.manifest.new-dependency':
      return {}; // no selectors — repo-wide, no ComponentRef (ADR 013)
    default:
      return {};
  }
}

export function printDryRunReport(result: DryRunResult): void {
  console.log(`align build — ${result.docRelPath}\n`);
  for (const section of result.proposal.sections) {
    console.log(`  [${section.tier.padEnd(7)}] ${section.headingText} (${section.ruleIds.length} rule(s))`);
  }

  if (result.diff.added.length > 0) {
    console.log(`\n  + ${result.diff.added.length} added:`);
    for (const r of result.diff.added) console.log(`      ${r.id}  ${quoteOf(r)}`);
  }
  if (result.diff.changed.length > 0) {
    console.log(`\n  ~ ${result.diff.changed.length} changed:`);
    for (const c of result.diff.changed) console.log(`      ${c.after.id}  ${quoteOf(c.after)}`);
  }
  if (result.diff.provenanceOnlyChanged.length > 0) {
    console.log(`\n  ${result.diff.provenanceOnlyChanged.length} unchanged (provenance-only updates — because/source text differs, nothing structural):`);
    for (const c of result.diff.provenanceOnlyChanged) console.log(`      ${c.after.id}  ${quoteOf(c.after)}`);
  }
  if (result.diff.removed.length > 0) {
    console.log(`\n  - ${result.diff.removed.length} removed:`);
    for (const r of result.diff.removed) console.log(`      ${r.id}`);
  }
  if (result.diff.added.length + result.diff.changed.length + result.diff.removed.length === 0) {
    console.log(`\n  no structural rule changes (empty diff)${result.diff.provenanceOnlyChanged.length > 0 ? ' — provenance-only updates above' : ''}.`);
  }

  if (result.proposal.flagged.length > 0) {
    console.log(`\n  ${result.proposal.flagged.length} flagged (never silently written):`);
    for (const f of result.proposal.flagged) console.log(`      [${f.reason}] ${f.sourceFile}:${f.sourceLineRange.startLine}  ${f.detail}`);
  }

  if (result.proposal.proseSections.length > 0) {
    console.log(`\n  ${result.proposal.proseSections.length} prose section(s) need judgment — use \`align_propose_rules\` (MCP) or wait for Stage 4 BYOK:`);
    for (const p of result.proposal.proseSections) console.log(`      ${p.headingText} (${p.startLine}-${p.endLine})`);
  }

  console.log(`\n  impact: adds ${result.impact.addedNew.length} new violation(s), masks ${result.impact.maskedBaselined.length} previously-baselined.`);
  if (result.impact.addedNew.length > 0) {
    for (const v of result.impact.addedNew.slice(0, 10)) console.log(`      ${v.file}:${v.range.startLine} [${v.ruleId}] ${renderViolationMessage(v)}`);
    if (result.impact.addedNew.length > 10) console.log(`      ... +${result.impact.addedNew.length - 10} more`);
  }
}

function quoteOf(rule: DryRunResult['proposal']['rules'][number]): string {
  const q = rule.provenance.sourceQuote;
  return q === undefined ? '' : `"${q.length > 80 ? `${q.slice(0, 77)}...` : q}"`;
}
