// ADR 029's substrate, end-to-end against a real project and real binaries: `align check` records
// what it observed, nothing else does, and a corrupt record cannot block a command.
//
// **What this scenario covers, and what covers the rest.** ADR 029 §8 asks for three things. The
// first — no record → today's behaviour — is here. The D015 reproduction staying red now lives in
// `scan-history-refuses-forged-transfer.mjs`, written once `store.applyMoves` was wired; until then
// it would have been a scenario that passed because nothing read the record [S-05].
//
// The third, "a record from a different `scopeIdentity` → today's behaviour", is deliberately NOT an
// integration scenario, and the reason is a correction to §8 rather than a gap: `wasViolationObservedAt`
// is the only question a consumer asks today, and it is deliberately NOT gated on `scopeIdentity`
// (a positive observation stays true when `excludes` changes — see `createScanHistoryProbe`). So the
// scenario §8 imagines would assert that a scope change does nothing, which is true but is not a
// property of the scope machinery; it is the absence of one. The asymmetry itself is pinned where it
// is decided, in `core/test/scan-history-probe.test.ts` and again from the consumer's side in
// `core/test/scan-history-move-refusal.test.ts`.
//
// **No `expectFailOn`.** Nothing here is a defect pinned against a published version: 0.1.4 has no
// scan history at all, so every assertion below would fail on it for the uninteresting reason that
// the feature does not exist. The calibrated `expectFailOn` scenarios each reproduce a specific
// defect, and one that only proved "this version is older" would dilute what the release gate's
// calibration means. `scan-history-refuses-forged-transfer.mjs` — this scenario's sibling, and the
// eighth calibrated one — is the counter-example that shows the distinction is real rather than a
// convenient exemption: it uses the same feature and DOES carry `expectFailOn`, because on 0.1.4 it
// reproduces D015 and lands a human's `acceptedBy: manual` on a never-reviewed violation at exit 0.
export default {
  id: 'scan-history-record-written',
  project: 'nest',
  description:
    'align check writes .align/last-scan.json and keeps it in step with the repository; init and doctor do not write it; ' +
    'a corrupted record is replaced rather than allowed to fail the run (ADR 029, LEDGER D021).',
  // ADR 026. Every path here comes from `init --accept-existing` (see init-fresh-project.mjs for the
  // per-path trace) plus the `install` step's package-lock.json — and `.align/last-scan.json`, the
  // artifact this scenario exists for. `introduce-arch-violation` edits align.config.ts, already
  // declared.
  writeSet: [
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'CLAUDE.md',
    '.gitignore',
    '.align/baseline.json',
    '.align/version.json',
    '.align/last-scan.json',
  ],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0 } },

    // `init` scans, and must NOT record: a surface that moves the temporal reference forward without
    // making a transfer decision against it causes a false refusal on the next legitimate rename
    // (ADR 029 §7.3). Asserted before the first check, when the file's absence is unambiguous.
    { assert: { kind: 'exists', file: '.align/last-scan.json', equals: false } },
    { run: 'doctor', expect: { exit: 0 } },
    { assert: { kind: 'exists', file: '.align/last-scan.json', equals: false } },

    { run: 'check', expect: { exit: 0 } },
    { assert: { kind: 'exists', file: '.align/last-scan.json', equals: true } },
    { snapshot: 'after-first-check' },

    // ADR 029 §7.1 at the granularity this harness can see. `observedAt` is normalized away
    // (`lib/normalize.mjs`), so what this asserts is that the OBSERVATION is stable across two
    // identical scans — which is the comparison §7.1 itself specifies. The stronger claim, that no
    // write happened at all, is pinned on the file's inode in
    // `packages/cli/test/scan-observation-write.test.ts`; a normalized comparison structurally
    // cannot distinguish "not rewritten" from "rewritten identically", and saying so here is
    // cheaper than a reader later assuming it did.
    { run: 'check', expect: { exit: 0 } },
    { assert: { kind: 'fileUnchanged', file: '.align/last-scan.json', since: 'after-first-check' } },

    // The record follows the repository. Without this, every assertion above is satisfied by a
    // writer that recorded once and never again — which would leave the history permanently stuck
    // on the first scan align ever ran, the exact failure the pair above cannot see on its own.
    { mutate: 'introduce-arch-violation' },
    { run: 'check', expect: { exit: 1 } },
    { assert: { kind: 'fileChanged', file: '.align/last-scan.json', since: 'after-first-check' } },

    // LEDGER D021, end-to-end. ADR 029 §7.4 originally specified that a corrupt record should throw,
    // borrowing `baseline.json`'s discipline; here that would mean a truncated, GITIGNORED cache
    // failing every command in the repository until a human found and deleted a file they cannot see
    // in `git status`. ADR 030 §4 was amended for the same misapplied rule one day earlier, on
    // `.align/.lock`, where it bricked the repository it was protecting.
    { snapshot: 'before-corruption' },
    { mutate: 'corrupt-last-scan-record' },
    // Exit 1 for the VIOLATION introduced above and nothing else — the corrupt cache changes no
    // verdict. `stderrNotContains: 'align check:'` is the specific guard: that prefix is
    // `reportCliError`'s, so its presence would mean the record had become a way to fail a command.
    {
      run: 'check',
      expect: {
        exit: 1,
        stdoutContains: 'verdict: red',
        stderrContains: 'ignoring',
        stderrNotContains: 'align check:',
      },
    },
    // ...and it healed itself. `fileUnchanged` rather than `fileChanged`, and the direction is the
    // assertion: the repository did not change between the two checks, so a record correctly
    // regenerated is byte-identical to the pre-corruption one once `observedAt` is normalized away.
    // Had align left the truncated bytes in place, the capture would be raw text on the parse-error
    // path and this would fail — which is exactly the state a human would otherwise have to fix by
    // hand.
    { assert: { kind: 'fileUnchanged', file: '.align/last-scan.json', since: 'before-corruption' } },
  ],
};
