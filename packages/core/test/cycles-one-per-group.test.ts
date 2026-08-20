import { describe, expect, it } from 'vitest';
import { evaluateNoCycles } from '../src/rules/evaluators.js';
import { renderViolationMessage } from '../src/types/violation.js';
import { toComponentName } from '../src/types/branded.js';
import { edge, graph, node } from './helpers.js';
import type { ArchNoCyclesRule } from '../src/types/ir.js';

/**
 * LEDGER **D054** — `arch.no-cycles` reports ONE cycle per strongly connected component, and said
 * nothing about doing so.
 *
 * Reported from a real 50-package monorepo alongside D052: a fixture with three cycles reports two,
 * and fixing the reported one promotes a previously-hidden cycle in the same component — the count
 * stays put. In that repository align reported 12 and it took **17 distinct fixes**, with the number
 * refusing to fall for most of them. "12 → 12" after a day of real work reads as no progress at all.
 *
 * Reproduced here and against the reporter's fixture: `src/a1 <-> a2`, `src/b1 <-> b2`, and
 * `src/b1 <-> b3` are three cycles in two SCCs, and align reports two violations.
 *
 * **One-per-SCC is kept, deliberately, and the reporter agrees.** Enumerating every cycle in a
 * component is exponential in the worst case, and an SCC genuinely IS one architectural problem —
 * a group of mutually reachable files. The defect is that the output presents a representative as
 * if it were the whole, so a user reads the count as a work estimate and their progress as zero.
 *
 * **Fingerprints are why this is a message change and not a selection change.** The violation id is
 * `computeFingerprint(['no-cycles', ruleId, ...chain])` — the chain IS the identity. Reporting a
 * different cycle, or more of them, re-identifies every baselined cycle entry in every repository
 * using align. Changing what the message SAYS costs nothing and fixes the actual complaint.
 */

const CYCLES_RULE: ArchNoCyclesRule = { kind: 'arch.no-cycles', id: 'arch.no-cycles:repo', scope: 'repo', includeTypeOnly: false, provenance: {} };

/** Two SCCs: {a1,a2} with one cycle, {b1,b2,b3} with two distinct cycles through b1. */
function threeCyclesInTwoGroups(): ReturnType<typeof graph> {
  return graph(
    [node('src/a1.ts', 'app'), node('src/a2.ts', 'app'), node('src/b1.ts', 'app'), node('src/b2.ts', 'app'), node('src/b3.ts', 'app')],
    [
      edge('src/a1.ts', 'src/a2.ts'),
      edge('src/a2.ts', 'src/a1.ts'),
      edge('src/b1.ts', 'src/b2.ts'),
      edge('src/b2.ts', 'src/b1.ts'),
      edge('src/b1.ts', 'src/b3.ts'),
      edge('src/b3.ts', 'src/b1.ts'),
    ],
  );
}

const COMPONENTS = { [toComponentName('app')]: { name: 'app', selector: { kind: 'glob' as const, patterns: ['src/**'] }, empty: 'fail' as const } };

describe('a cycle violation says it represents a group [D054]', () => {
  it('names how many files are in the mutually-dependent group', () => {
    const violations = evaluateNoCycles(CYCLES_RULE, threeCyclesInTwoGroups(), COMPONENTS);

    // PREMISE [S-05]: two violations for three cycles is the defect; if this ever becomes three the
    // test below is asserting something else entirely.
    expect(violations).toHaveLength(2);

    const bGroup = violations.find((v) => renderViolationMessage(v).includes('src/b'));
    expect(bGroup).toBeDefined();
    const message = renderViolationMessage(bGroup!);

    // Before the fix: "Import cycle of 2 edge(s) detected: src/b3.ts -> src/b1.ts -> src/b3.ts."
    // and nothing else — a representative presented as the whole finding.
    expect(message).toMatch(/3 file/);
    // Every member named, so the user can see the group rather than infer it.
    for (const f of ['src/b1.ts', 'src/b2.ts', 'src/b3.ts']) expect(message).toContain(f);
    // And the thing that actually cost the reporter a day: breaking this one may not clear the group.
    expect(message).toMatch(/one cycle|may (still )?remain|other cycles/i);
  });

  it('a plain two-file cycle stays plain [S-04]', () => {
    // Calibration. The overwhelming majority of cycles are exactly two files, where the group IS the
    // cycle and extra prose about "groups" would be noise on every ordinary report.
    const g = graph(
      [node('src/x.ts', 'app'), node('src/y.ts', 'app')],
      [edge('src/x.ts', 'src/y.ts'), edge('src/y.ts', 'src/x.ts')],
    );

    const message = renderViolationMessage(evaluateNoCycles(CYCLES_RULE, g, COMPONENTS)[0]!);

    expect(message).toContain('Import cycle of 2 edge(s)');
    expect(message).not.toMatch(/group/i);
  });

  it('the violation id does not change — baselines must not churn [S-04]', () => {
    // The constraint that shaped the whole fix. `computeFingerprint(['no-cycles', ruleId, ...chain])`
    // is the identity; this change touches only the rendered message, so an accepted cycle entry
    // keeps matching. Pinned as an exact id so a future edit to the chain, the selection, or the
    // fingerprint inputs fails here rather than silently re-identifying every baselined cycle.
    const before = evaluateNoCycles(CYCLES_RULE, threeCyclesInTwoGroups(), COMPONENTS).map((v) => v.id).sort();

    expect(before).toEqual(['06c65a065f1bfb1d', 'fca66f7dd1ca5ced']);
  });
});
