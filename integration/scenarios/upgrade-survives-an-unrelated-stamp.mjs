// LEDGER **D028**. `align upgrade` asked `.align/version.json` the wrong question.
//
// `alignVersion` means "who last wrote anything under `.align/`" and is stamped by EVERY
// committed-artifact writer — `baseline accept`, `baseline prune`, `build --apply`, `export-ir`, and
// any `check` that move-transfers. `baselineReconciledBy` means "the version under which the baseline
// was last DELIBERATELY reconciled" and is written only by `init` and by `upgrade`'s final step.
// `upgrade` gated on the first, so **one unrelated command run under the new binary convinced it
// there was nothing left to do — permanently.**
//
// `version-file.ts` records that an earlier ADR draft specified last-writer-of-`baseline.json` and was
// rejected precisely because incidental writers "would make a 'last writer' field read as current
// after routine CI, defeating the field's purpose". The field was built to avoid the hazard; the
// consumer was then wired to the hazard. Until this scenario, `baselineReconciledBy` had a writer, a
// schema, seven doc comments and ZERO readers.
//
// **Step 4 is the calibration and step 6 is the pin**, and the pair is the whole scenario: the same
// command, either side of an `export-ir` that does not touch `baseline.json` at all. If step 4 ever
// stops printing the range, the fixture has stopped reproducing anything and step 6 would pass
// vacuously [S-05].
//
// **`export-ir` chosen deliberately over `baseline accept`.** Accept at least writes the baseline, so
// a reader could tell themselves the stamp was "sort of" earned. `export-ir` writes only
// `.align/ruleset-ir.json` and leaves the baseline byte-identical — it is the purest form of the
// defect, and it is an ordinary command (ADR 014's trusted-context export, the thing you run before
// `check --untrusted` in CI).
export default {
  id: 'upgrade-survives-an-unrelated-stamp',
  project: 'nest',
  description:
    'An unrelated `.align/` write must not convince `align upgrade` the baseline is reconciled: upgrade reads ' +
    'baselineReconciledBy, not alignVersion (ADR 022, LEDGER D028).',
  // No `expectFailOn`: every step installs `local` explicitly, so this scenario runs the same binaries
  // whatever `--targets` says and cannot distinguish published versions. The defect is pinned against
  // the CODE by `packages/cli/test/upgrade.test.ts`, where the pre-fix behaviour is measured.
  //
  // ADR 026. `init --accept-existing` contributes the COMMON set (see init-fresh-project.mjs);
  // `export-ir` adds `.align/ruleset-ir.json` and re-stamps `.align/version.json`, which the mutation
  // also rewrites. `upgrade --notes` is read-only and adds nothing — asserted below rather than
  // assumed.
  writeSet: [
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'CLAUDE.md',
    '.gitignore',
    '.align/baseline.json',
    '.align/version.json',
    '.align/ruleset-ir.json',
  ],
  steps: [
    { install: 'local' },
    { run: 'init --accept-existing', expect: { exit: 0 } },

    // A repository last reconciled under 0.1.4, which is what every real one looks like the moment its
    // binary is upgraded. Local binaries always stamp BOTH fields to the current version, so this
    // state is unreachable by running align — hence the mutation.
    { mutate: 'stamp-version-file-as-0.1.4' },
    { snapshot: 'reconciled-under-0.1.4' },

    // STEP 4 — CALIBRATION. The range is visible, and `--notes` is read-only so nothing moves.
    // `keepVersion` because the assertion IS a version string: without it `normalizeVersionInText`
    // rewrites '0.1.4' to a placeholder and the check compares two placeholders — passing whatever
    // the range actually was. Measured: without it, step 4 failed to find '0.1.4 → ' at all.
    { run: 'upgrade --notes', keepVersion: true, expect: { exit: 0, stdoutContains: '0.1.4 → ', stdoutNotContains: 'Already at the current version' } },

    // THE INCIDENTAL WRITE. `export-ir` writes `.align/ruleset-ir.json` and stamps `alignVersion` on
    // the way past. It does not touch the baseline.
    { run: 'export-ir', expect: { exit: 0 } },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'reconciled-under-0.1.4' } },
    // NOT asserting that `.align/version.json` changed: the capture normalizes align versions inside
    // JSON too, so the pre- and post-stamp files are byte-identical once normalized and the assertion
    // could only ever fail (measured — it did). The stamp advancing is exactly what step 6 detects,
    // and detecting it through the observable behaviour is stronger than through the artifact.

    // STEP 6 — THE PIN. Same command as step 4, same repository as far as the BASELINE is concerned.
    // Before the fix this printed "Already at the current version — nothing to reconcile" and exited
    // 0, and no later `align upgrade` on that repository could ever be made to do anything again
    // without the user discovering `--from`.
    { run: 'upgrade --notes', keepVersion: true, expect: { exit: 0, stdoutContains: '0.1.4 → ', stdoutNotContains: 'Already at the current version' } },
  ],
};
