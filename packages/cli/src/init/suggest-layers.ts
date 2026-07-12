import type { DependencyGraph } from '@align/core';

export interface LayerSuggestion {
  readonly layer: string;
  readonly canDependOn: readonly string[];
  readonly evidence: string; // rendered into a comment above the suggested DSL line
}

/**
 * Coarse 3-tier layering inferred from the measured cross-component edge matrix — "apps depend on
 * libraries, libraries stay leaf" rather than kluster's hand-curated 8-component model (spike Q5).
 * Mechanical, not semantic: components with only outgoing cross-component edges are "top" (apps),
 * components with only incoming cross-component edges are "leaf" (libraries), everything else is
 * "middle." `align init` renders these as commented-out DSL lines (IMPLEMENTATION_PLAN.md Stage 1:
 * "~3 layer macros commented sensibly") — a human confirms before any of them go live.
 */
export function suggestLayers(graph: DependencyGraph): LayerSuggestion[] {
  const componentNames = [...new Set(graph.nodes.map((n) => n.component))].filter((c) => c !== '__unmapped__');
  if (componentNames.length < 2) return [];

  const fileToComponent = new Map(graph.nodes.map((n) => [n.file, n.component]));
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  const edgeCounts = new Map<string, number>();

  for (const edge of graph.edges) {
    const from = fileToComponent.get(edge.from);
    const to = fileToComponent.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    (outgoing.get(from) ?? outgoing.set(from, new Set()).get(from))?.add(to);
    (incoming.get(to) ?? incoming.set(to, new Set()).get(to))?.add(from);
    const key = `${from}>${to}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }

  const top: string[] = [];
  const leaf: string[] = [];
  const middle: string[] = [];
  for (const name of componentNames) {
    const hasOut = (outgoing.get(name)?.size ?? 0) > 0;
    const hasIn = (incoming.get(name)?.size ?? 0) > 0;
    if (hasOut && !hasIn) top.push(name);
    else if (hasIn && !hasOut) leaf.push(name);
    else middle.push(name);
  }

  const suggestions: LayerSuggestion[] = [];
  if (top.length > 0 && (middle.length > 0 || leaf.length > 0)) {
    const canDependOn = [...middle, ...leaf];
    suggestions.push({
      layer: top[0] as string,
      canDependOn,
      evidence: `'${top[0]}' has outgoing edges into ${canDependOn.map((c) => `'${c}'`).join(', ')} and none pointing back`,
    });
  }
  if (middle.length > 0 && leaf.length > 0) {
    suggestions.push({
      layer: middle[0] as string,
      canDependOn: leaf,
      evidence: `'${middle[0]}' depends on ${leaf.map((c) => `'${c}'`).join(', ')}, which take no cross-component dependencies`,
    });
  }
  if (leaf.length > 0) {
    suggestions.push({
      layer: leaf[0] as string,
      canDependOn: [],
      evidence: `'${leaf[0]}' has no outgoing cross-component edges today — a candidate for isolation`,
    });
  }
  return suggestions.slice(0, 3);
}
