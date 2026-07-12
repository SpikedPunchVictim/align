/**
 * Condensed symbol table (PLAN+FIX grounding input) — pure function over a `DependencyGraph`.
 *
 * v1 heuristic (documented honestly, per the task's instruction to be honest about heuristics):
 * "importable symbols from the graph" is scoped to files in the TARGET's own component. A
 * repo-wide table would blow the token budget on any non-trivial repo; component scope is the
 * cheapest reasonable proxy for "files the target may plausibly import" without doing full
 * module-resolution reachability analysis (which `DependencyGraph.edges` doesn't make free to
 * compute precisely — barrels/re-exports are not resolved, per `plugin-typescript`'s scanner).
 */
import type { DependencyGraph, RepoRelativePath } from '@align/core';
import type { SymbolTableEntry } from './fixProvider.js';

export function buildCondensedSymbolTable(target: RepoRelativePath, graph: DependencyGraph): readonly SymbolTableEntry[] {
  const targetNode = graph.nodes.find((n) => n.file === target);
  if (targetNode === undefined) return [];

  return graph.nodes
    .filter((n) => n.file !== target && n.component === targetNode.component && n.exports.length > 0)
    .map((n) => ({ file: n.file, exports: n.exports }))
    .sort((a, b) => a.file.localeCompare(b.file));
}
