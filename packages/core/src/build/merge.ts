import type { RuleIR } from '../types/ir.js';

/** Thrown when a hand-authored (`align.config.ts`) rule and a doc-generated rule share an id but
 * disagree on structural content — a fail-fast config-load error (CODING_BEST_PRACTICES.md §21),
 * never a silent pick-one. */
export class GeneratedRuleCollisionError extends Error {
  constructor(
    public readonly ruleId: string,
    baseRule: RuleIR,
    generatedRule: RuleIR,
  ) {
    super(
      `Rule id '${ruleId}' is defined both in align.config.ts and in .align/generated-rules.json ` +
        `with different content. Rename one of them, or make the two definitions agree. ` +
        `config: ${JSON.stringify(stripProvenance(baseRule))} vs generated: ${JSON.stringify(stripProvenance(generatedRule))}`,
    );
    this.name = 'GeneratedRuleCollisionError';
  }
}

function stripProvenance(r: RuleIR): unknown {
  const { provenance: _provenance, ...rest } = r;
  return rest;
}

function structurallyEqual(a: RuleIR, b: RuleIR): boolean {
  return JSON.stringify(stripProvenance(a)) === JSON.stringify(stripProvenance(b));
}

/**
 * The config-integration mechanism for `align build` (ADR 011): merges `.align/generated-rules.json`
 * into the hand-authored `align.config.ts` ruleset's rule list. Called by the CLI's config loader
 * (`packages/cli/src/config.ts`) — never by `defineProject` itself, which stays fs-free (core's
 * pure/no-I/O discipline, CODING_BEST_PRACTICES.md §14/15). This is the "least magical" of the
 * options ADR 011 named (an explicit `withGeneratedRules()` call in every `align.config.ts` vs. an
 * automatic merge at the loader boundary): every existing surface (`check`, `doctor`, `mcp`,
 * `build` itself) picks up generated rules for free, with zero required edits to a human-authored
 * file — "nothing machine-written lives inside a human-edited file" (ADR 011) extends to not even
 * requiring an *import statement* referencing the machine-written file.
 *
 * Collision policy: an id present in both lists must be structurally identical (same `kind` and
 * selectors) or this throws `GeneratedRuleCollisionError`. When identical, the generated rule's
 * richer provenance (`sourceFile`/`sourceLineRange`/`sourceQuote`) is merged onto the surviving
 * rule so its violations still quote the doc; a hand-authored `.because()` is preserved by
 * prefixing it onto the generated "Enforced by ..." phrase rather than being discarded.
 */
export function mergeGeneratedRules(baseRules: readonly RuleIR[], generatedRules: readonly RuleIR[]): readonly RuleIR[] {
  const baseById = new Map(baseRules.map((r) => [r.id, r]));
  const merged: RuleIR[] = [];
  const consumedBaseIds = new Set<string>();

  for (const generated of generatedRules) {
    const base = baseById.get(generated.id);
    if (base === undefined) {
      merged.push(generated);
      continue;
    }
    if (!structurallyEqual(base, generated)) {
      throw new GeneratedRuleCollisionError(generated.id, base, generated);
    }
    consumedBaseIds.add(base.id);
    const baseBecause = base.provenance.because;
    const generatedBecause = generated.provenance.because;
    const because =
      baseBecause === undefined
        ? generatedBecause
        : generatedBecause === undefined
          ? baseBecause
          : `${baseBecause} ${generatedBecause}`;
    merged.push({
      ...generated,
      provenance: { ...generated.provenance, ...(because === undefined ? {} : { because }) },
    } as RuleIR);
  }

  for (const base of baseRules) {
    if (!consumedBaseIds.has(base.id)) merged.push(base);
  }

  return merged;
}
