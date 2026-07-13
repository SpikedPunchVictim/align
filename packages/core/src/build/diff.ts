import type { RuleIR } from '../types/ir.js';

export interface RuleDiff {
  readonly added: readonly RuleIR[];
  readonly removed: readonly RuleIR[];
  // Structural changes only (kind/target/params differ) — see `provenanceOnlyChanged` below for
  // the sibling bucket this field used to (incorrectly) include.
  readonly changed: readonly { readonly before: RuleIR; readonly after: RuleIR }[];
  readonly unchanged: readonly RuleIR[]; // byte-identical, including provenance — unchanged meaning
  // Live-session finding (IMPLEMENTATION_PLAN.md Stage 3 log): an agent-attached `.because()` text
  // made 10 byte-identical rules show up under `changed`, even though nothing about what the rules
  // DO differs — provenance/because is metadata about a rule, not the rule's evaluated behavior.
  // Split out so callers can report "N unchanged (provenance-only updates)" separately from a
  // genuine structural change, and so impact-delta re-evaluation (which is unaffected either way,
  // since violation fingerprints never depend on provenance — see this module's test suite) isn't
  // miscounted as having touched more rules than it did.
  readonly provenanceOnlyChanged: readonly { readonly before: RuleIR; readonly after: RuleIR }[];
}

/** Canonical (sorted-key) JSON serialization, so two objects built with different property
 * insertion order still compare equal — full-fidelity structural comparison including
 * `provenance`, since a provenance-only change (a reworded sentence whose extracted selectors
 * didn't change) is exactly the "changed" case this diff must surface. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[key] = (val as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return val;
  });
}

/** Same "everything except provenance" structural view `build/propose.ts`'s local
 * `structurallyEqual` uses for conflict detection — kept as a separate, private helper here
 * (rather than a shared export) since the two call sites compare for different reasons (dedup
 * candidates vs. classifying a diff) and a shared abstraction would be a premature one for two
 * call sites doing the same one-line `delete provenance` (CODING_BEST_PRACTICES.md's rule-of-three). */
function withoutProvenance(rule: RuleIR): unknown {
  const { provenance: _provenance, ...rest } = rule;
  return rest;
}

/**
 * Rule-level diff minimization (ADR 011): because rule ids are content-addressed (`ground.ts`),
 * an IR-identical re-proposal always keeps the same id, so this diff is a plain set comparison by
 * id — no stateful matching heuristics needed. `unchanged` entries are what makes a same-doc
 * rebuild an empty diff in the parts that matter (added/removed/changed are all empty).
 */
export function diffGeneratedRules(existing: readonly RuleIR[], proposed: readonly RuleIR[]): RuleDiff {
  const existingById = new Map(existing.map((r) => [r.id, r]));
  const proposedById = new Map(proposed.map((r) => [r.id, r]));

  const added: RuleIR[] = [];
  const changed: { before: RuleIR; after: RuleIR }[] = [];
  const provenanceOnlyChanged: { before: RuleIR; after: RuleIR }[] = [];
  const unchanged: RuleIR[] = [];

  for (const [id, after] of proposedById) {
    const before = existingById.get(id);
    if (before === undefined) {
      added.push(after);
    } else if (canonical(before) === canonical(after)) {
      unchanged.push(after);
    } else if (canonical(withoutProvenance(before)) === canonical(withoutProvenance(after))) {
      provenanceOnlyChanged.push({ before, after });
    } else {
      changed.push({ before, after });
    }
  }

  const removed: RuleIR[] = [];
  for (const [id, before] of existingById) {
    if (!proposedById.has(id)) removed.push(before);
  }

  return { added, removed, changed, unchanged, provenanceOnlyChanged };
}
