/**
 * LEDGER D069 — `validateScenario` rejected an unknown key at every level except the top one.
 *
 * This file exists to kill one class: a key that looks like an assertion, is silently ignored, and
 * leaves a scenario passing while checking less than it claims (F1, and shape S-05). It does that
 * thoroughly for `expect`, `assert`, `mcpCall`, and each step kind — and never once for the
 * scenario object itself. So `expectFailsOn: ['0.1.4']`, `writeset: [...]`, or `tag: ['smoke']`
 * loaded clean and did nothing:
 *
 *   - a typo'd `expectFailOn` silently un-pins a scenario. It stops being counted among the ten
 *     that calibrate the harness, and nothing says the count moved;
 *   - a typo'd `writeSet` degrades to ADR 026's fail-closed empty default. That direction is the
 *     safe one, but the failure names the wrong cause;
 *   - a typo'd `tags` drops the scenario out of every `--tags` selection forever.
 *
 * Also pinned here: two invariants the top-level check makes reachable. A duplicate scenario `id`
 * (the calibration lookup is `matrix.find(... scenarioId === s.id)`, which silently takes the first
 * match), and `expectFailOn: ['local']`, which asks the gate target to fail and cannot ever mean
 * what its author intended.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { validateScenario, validateNoDuplicateIds } from './spec-validate.mjs';

const ok = () => ({
  id: 's',
  project: 'nest',
  description: 'a scenario',
  steps: [{ run: 'align check', expect: { exit: 0 } }],
});

const throwsMatching = (scenario, re) => assert.throws(() => validateScenario(scenario), re);

describe('top-level scenario keys (LEDGER D069)', () => {
  it('accepts the known key set', () => {
    validateScenario({ ...ok(), writeSet: ['.align/baseline.json'], tags: ['smoke'], expectFailOn: ['0.1.4'] });
  });

  it('rejects a misspelled expectFailOn instead of silently un-pinning the scenario', () => {
    throwsMatching({ ...ok(), expectFailsOn: ['0.1.4'] }, /unknown key\(s\) \[expectFailsOn\]/);
  });

  it('rejects a misspelled writeSet', () => {
    throwsMatching({ ...ok(), writeset: ['.align/baseline.json'] }, /unknown key\(s\) \[writeset\]/);
  });

  it('rejects a misspelled tags', () => {
    throwsMatching({ ...ok(), tag: ['smoke'] }, /unknown key\(s\) \[tag\]/);
  });

  it('names every unknown key at once, not just the first', () => {
    throwsMatching({ ...ok(), foo: 1, bar: 2 }, /unknown key\(s\) \[foo, bar\]/);
  });

  it('requires description to be a non-empty string when present', () => {
    throwsMatching({ ...ok(), description: '' }, /description/);
  });
});

describe('expectFailOn names a published version, never the gate target (LEDGER D069)', () => {
  it("rejects 'local'", () => {
    // A pin asserts a PUBLISHED version demonstrably has the defect. Pinning 'local' asserts the
    // code being released is broken — the gate would fail on it anyway, and the pin would then be
    // read as "expected", inverting the gate.
    throwsMatching({ ...ok(), expectFailOn: ['local'] }, /'local'/);
  });

  it('rejects a duplicate target', () => {
    throwsMatching({ ...ok(), expectFailOn: ['0.1.4', '0.1.4'] }, /duplicate/i);
  });
});

describe('scenario ids are unique across the corpus (LEDGER D069)', () => {
  it('accepts distinct ids', () => {
    validateNoDuplicateIds([{ id: 'a' }, { id: 'b' }]);
  });

  it('rejects a duplicate id, naming it', () => {
    // `--scenarios a` would select both, and the calibration lookup takes whichever row it finds
    // first — so the pin on one could be satisfied by the other's result.
    assert.throws(() => validateNoDuplicateIds([{ id: 'a' }, { id: 'b' }, { id: 'a' }]), /duplicate scenario id\(s\): a/);
  });
});
