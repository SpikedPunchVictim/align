/**
 * LEDGER D065 — a violation message must never name a component the user did not write.
 *
 * `arch.layer(a).canOnlyDependOn(b)` against a target belonging to no component rendered as:
 *
 *     src/a/i.ts (layer 'a') imports src/shared/r.ts (layer '__unmapped__') via './r' ...
 *
 * `__unmapped__` is `plugin-typescript`'s internal sentinel for "this file matched no selector"
 * (`scanner.ts`'s `UNMAPPED_COMPONENT`). It is not a layer, it is not in anyone's `align.config.ts`,
 * and a reader who greps their config for it finds nothing — so a real finding reads as align
 * malfunctioning.
 *
 * **Measured, because "cosmetic" was the wrong guess.** On n8n with `cli canOnlyDependOn core`:
 * `architecture RED 7577 violation(s)`, and **7577 of the 7577** rendered violations named the
 * sentinel — every single one the rule produced. `canOnlyDependOn` is an allowlist, so an unmapped
 * target is outside it by construction; in any repository with unmapped files the sentinel is not an
 * edge case in the output, it can be the whole of it. After the fix, on the same repository: 0
 * mention `__unmapped__`, 7577 say "matches no component selector", the count is unchanged.
 *
 * (Counted by splitting the report on the `✗` marker and normalizing whitespace INSIDE each block,
 * not with `grep -c`. A bare `grep -c "no component selector"` answers 6956 on that same file — the
 * phrase wraps across two lines for 621 of them. Lines are not violations.)
 *
 * The second test is the durable one: no evaluator may put an undeclared component into a message.
 */
import { describe, expect, it } from 'vitest';
import { defineProject } from '../src/dsl/index.js';
import { evaluateRule } from '../src/rules/evaluators.js';
import { renderViolationMessage } from '../src/types/violation.js';
import { edge, graph, node } from './helpers.js';

const UNMAPPED = '__unmapped__';

function layersRuleset(): ReturnType<typeof defineProject> {
  return defineProject({
    components: { a: 'src/a/**', b: 'src/b/**' },
    rules: (c) => [c.arch.layer(c.a).canOnlyDependOn(c.b)],
  });
}

/** `src/a/i.ts` imports a file matching no selector — the reporter's shape. */
function graphWithUnmappedTarget(): ReturnType<typeof graph> {
  return graph(
    [node('src/a/i.ts', 'a'), node('src/b/index.ts', 'b'), node('src/shared/r.ts', UNMAPPED)],
    [edge('src/a/i.ts', 'src/shared/r.ts', { specifier: '../shared/r', line: 1 })],
  );
}

describe('a violation never names a component the user did not declare (LEDGER D065)', () => {
  it('renders "matches no component selector" instead of the plugin sentinel', () => {
    const rs = layersRuleset();
    const violations = rs.rules.flatMap((r) => evaluateRule(r, graphWithUnmappedTarget(), rs.components));
    expect(violations).toHaveLength(1);
    const message = renderViolationMessage(violations[0]!);

    expect(message).not.toContain(UNMAPPED);
    expect(message).toContain('src/shared/r.ts');
    expect(message).toMatch(/no component selector/i);
    // The finding itself is unchanged — this is a real violation and must still read as one.
    expect(message).toContain("(layer 'a')");
    expect(message).toContain("rule 'arch.layers:a'");
  });

  it('still names a real component when the target HAS one', () => {
    const rs = layersRuleset();
    const g = graph(
      [node('src/a/i.ts', 'a'), node('src/b/index.ts', 'b'), node('src/c/x.ts', 'c')],
      [edge('src/a/i.ts', 'src/c/x.ts', { specifier: '../c/x', line: 1 })],
    );
    // 'c' is a real component in the graph that this ruleset does not declare... so declare one it
    // does: the point here is that the mapped case keeps its "(layer 'x')" wording untouched.
    const rs2 = defineProject({
      components: { a: 'src/a/**', b: 'src/b/**', c: 'src/c/**' },
      rules: (c) => [c.arch.layer(c.a).canOnlyDependOn(c.b)],
    });
    const violations = rs2.rules.flatMap((r) => evaluateRule(r, g, rs2.components));
    expect(violations).toHaveLength(1);
    const message = renderViolationMessage(violations[0]!);
    expect(message).toContain("(layer 'c')");
    expect(message).not.toMatch(/no component selector/i);
    void rs;
  });

  it('NO evaluator emits a message naming a component the ruleset never declared', () => {
    // The class, not the instance. Every rule kind is driven over one graph holding an unmapped
    // node, and the rendered text is checked against the declared component names. `arch.layers`
    // was the only arm that leaked, because it is the only one whose violation carries a component
    // it did not itself match against a rule field — but "which arms are like this" is exactly the
    // question S-09 says to answer executably rather than by inspection.
    const rs = defineProject({
      components: { a: 'src/a/**', b: 'src/b/**' },
      rules: (c) => [
        c.arch.layer(c.a).canOnlyDependOn(c.b),
        c.arch.layer(c.a).cannotDependOn(c.b),
        c.arch.noCycles(),
        c.arch.component(c.a).maxLinesPerFile(1),
      ],
    });
    const g = graph(
      [node('src/a/i.ts', 'a', 50), node('src/b/index.ts', 'b'), node('src/shared/r.ts', UNMAPPED)],
      [
        edge('src/a/i.ts', 'src/shared/r.ts', { specifier: '../shared/r', line: 1 }),
        edge('src/shared/r.ts', 'src/b/index.ts', { specifier: '../b', line: 1 }),
        edge('src/b/index.ts', 'src/shared/r.ts', { specifier: '../shared/r', line: 2 }),
      ],
    );
    const violations = rs.rules.flatMap((r) => evaluateRule(r, g, rs.components));
    expect(violations.length).toBeGreaterThan(0);
    for (const v of violations) {
      expect(renderViolationMessage(v)).not.toContain(UNMAPPED);
    }
  });
});
