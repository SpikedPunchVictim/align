import type { CycleEdge, Violation } from '../types/violation.js';

/**
 * Fenced Mermaid `graph LR` diagram for one architecture violation instance — an `explain`-only
 * surface (ADR 007: pull-on-demand prose/diagram, never included in the terse `align_check` /
 * `align_violations` machine payloads). One violation's diagram, not the whole rule's violation
 * set — explain answers "why did THIS fire and how do I read it", not a full survey.
 *
 * - `no-cycles`: the cycle's chain, with the suggested break edge drawn as a dashed link labeled
 *   `BREAK: <specifier>` instead of a normal solid arrow.
 * - `no-dependency` / `layers`: the two-node offending edge, component/layer names alongside the
 *   concrete files, labeled with the forbidden specifier.
 * - `metric`: a single node (there is no offending edge — the violation is file-level, not
 *   import-direction-level) labeled with the component, file, and measured-vs-max lines.
 */
export function buildViolationMermaid(violation: Violation): string {
  switch (violation.kind) {
    case 'no-cycles':
      return fence(cycleDiagram(violation.chain, violation.suggestedBreakEdge));
    case 'no-dependency':
      return fence(
        edgeDiagram(violation.fromComponent, violation.fromFile, violation.toComponent, violation.toFile, violation.specifier),
      );
    case 'layers':
      return fence(edgeDiagram(violation.fromLayer, violation.fromFile, violation.toLayer, violation.toFile, violation.specifier));
    case 'metric':
      return fence(metricDiagram(violation.component, violation.file, violation.value, violation.threshold));
    default: {
      const exhaustive: never = violation;
      throw new Error(`unhandled violation kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function fence(body: string): string {
  return `\`\`\`mermaid\n${body}\n\`\`\``;
}

function cycleDiagram(chain: readonly CycleEdge[], suggestedBreakEdge: CycleEdge): string {
  const ids = new Map<string, string>();
  const lines: string[] = ['graph LR'];

  const idFor = (file: string): string => {
    const existing = ids.get(file);
    if (existing !== undefined) return existing;
    const id = `n${ids.size}`;
    ids.set(file, id);
    lines.push(`  ${id}["${escapeLabel(file)}"]`);
    return id;
  };

  for (const hop of chain) {
    const fromId = idFor(hop.from);
    const toId = idFor(hop.to);
    lines.push(
      sameEdge(hop, suggestedBreakEdge)
        ? `  ${fromId} -. "BREAK: ${escapeLabel(hop.specifier)}" .-> ${toId}`
        : `  ${fromId} -->|"${escapeLabel(hop.specifier)}"| ${toId}`,
    );
  }
  return lines.join('\n');
}

function sameEdge(a: CycleEdge, b: CycleEdge): boolean {
  return a.from === b.from && a.to === b.to && a.specifier === b.specifier;
}

function edgeDiagram(fromLabel: string, fromFile: string, toLabel: string, toFile: string, specifier: string): string {
  return [
    'graph LR',
    `  a["${escapeLabel(fromLabel)}<br/>${escapeLabel(fromFile)}"]`,
    `  b["${escapeLabel(toLabel)}<br/>${escapeLabel(toFile)}"]`,
    `  a -->|"${escapeLabel(specifier)} (forbidden)"| b`,
  ].join('\n');
}

function metricDiagram(component: string, file: string, value: number, threshold: number): string {
  return ['graph LR', `  a["${escapeLabel(component)}<br/>${escapeLabel(file)}<br/>${value} lines (max ${threshold})"]`].join('\n');
}

function escapeLabel(s: string): string {
  return s.replace(/"/g, '\\"');
}
