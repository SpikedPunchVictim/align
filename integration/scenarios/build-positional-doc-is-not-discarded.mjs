// LEDGER D064 — an argument the user typed must never be silently discarded.
//
// Reported against `align build ARCHITECTURE.md`: commander accepted the positional, `build`'s
// action never read it, and the run proceeded against `docs/ARCHITECTURE-RULES.md`. In the
// reporter's repository that default did not exist, so they got *"Doc not found:
// docs/ARCHITECTURE-RULES.md"* — an error naming a path they had never typed. In a repository where
// the default DOES exist it is worse: exit 0 and a full build report, for a document nobody asked
// about. That is this project's severity-zero shape in miniature.
//
// **Why the doc lives at the repo root and not at `docs/ARCHITECTURE-RULES.md`.** With a doc at the
// default path, "read the argument" and "ignore the argument" produce identical output, and a
// scenario written that way would pass against the unfixed binary [S-05]. `write-root-architecture-
// doc` puts it at `ARCHITECTURE.md` — the reporter's own filename — so `stdoutNotContains` on the
// default path is a real discriminator rather than a decoration.
//
// **`expectFailOn: ['0.1.4']` is earned, and was verified rather than assumed** (2026-08-20, real
// published 0.1.4 installed from npm into a scratch project): `align build ARCHITECTURE.md` printed
// `Doc not found: docs/ARCHITECTURE-RULES.md` and exited 1 — the reporter's exact symptom, on a real
// published version. `align doctor oops` exited **0** on that same 0.1.4, silently ignoring the
// stray argument. Both are regressions a published version demonstrably has, which is precisely what
// CLAUDE.md says a pin is for.
export default {
  id: 'build-positional-doc-is-not-discarded',
  project: 'nest',
  description:
    'align build <doc> reads THAT doc and never the default; a doc named twice is a usage error (exit 2); a stray ' +
    'argument to a command that declares none is a usage error, not a silent no-op (LEDGER D064).',
  expectFailOn: ['0.1.4'],
  // ADR 026 write-set. COMMON set (see init-fresh-project.mjs's write-set comment for the
  // line-by-line derivation of those seven paths) plus the one file this scenario's mutation
  // creates. Every `align build` invocation here is a DRY RUN — no `--apply` — and `commands/
  // build.ts` writes nothing on that path ("Dry run only — nothing written"); the two refusals exit
  // before reaching any writer at all. `doctor` is read-only by construction.
  writeSet: [
    // ADR 029: every `align check` records what it observed in `.align/last-scan.json`. Declared
    // rather than exempted — a machine-local cache is still a path align writes into someone
    // else's repository, and ADR 026's set is what a reader consults to know that.
    '.align/last-scan.json',
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'CLAUDE.md',
    '.gitignore',
    '.align/baseline.json',
    '.align/version.json',
    // Created by the `write-root-architecture-doc` mutation below, not by align. A mutation's writes
    // are covered by the same whole-tree check as a command's (lib/scenario-runner.mjs takes
    // `treeBefore` before step 0 and `treeAfter` after the last step), so it has to be declared.
    'ARCHITECTURE.md',
  ],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' } },
    { mutate: 'write-root-architecture-doc' },
    // The default doc does not exist in this working copy, established BEHAVIOURALLY rather than by
    // an `exists` assert: `lib/capture.mjs` resolves a fixed, named catalog (`align.config.ts`,
    // `CLAUDE.md`, `.align/<name>`) and refuses an arbitrary path, so `exists` cannot be asked about
    // this file at all — asking errors the scenario rather than failing it (measured 2026-08-21).
    //
    // Running `build` with NO argument is the better proof anyway: it asserts the default path is
    // absent AND that the no-argument path still resolves to the default, which an `exists` assert
    // could not say. The error text is the reporter's exact symptom.
    { run: 'build', expect: { exit: 1, stderrContains: 'Doc not found: docs/ARCHITECTURE-RULES.md' } },
    // The defect, stated as the two things that must BOTH hold. `stdoutContains` alone would pass on
    // an align that read the default and happened to mention the positional somewhere; the
    // `stdoutNotContains` is what makes this a discriminator.
    {
      run: 'build ARCHITECTURE.md',
      expect: { exit: 0, stdoutContains: 'ARCHITECTURE.md', stdoutNotContains: 'docs/ARCHITECTURE-RULES.md' },
    },
    // Still absent afterwards: the dry run wrote nothing, and in particular did not conjure the
    // default doc into existence on its way past. Same behavioural form as above, and it doubles as
    // proof the successful positional run left the no-argument path behaving identically.
    { run: 'build', expect: { exit: 1, stderrContains: 'Doc not found: docs/ARCHITECTURE-RULES.md' } },
    // Naming the doc twice is ambiguous and align refuses rather than picking. Exit 2, not 1: this
    // is a USAGE error (`Command.error(..., { exitCode: 2 })`), and the distinction is load-bearing —
    // the first draft of the fix threw a CommanderError with a custom `align.*` code, which
    // `commanderExitCode` does not map, so the binary printed a raw stack trace while a
    // "did it throw?" unit assertion passed. Asserting the code here is what sees that.
    {
      run: 'build ARCHITECTURE.md --doc docs/ARCHITECTURE-RULES.md',
      expect: { exit: 2, stderrContains: 'name the doc to build' },
    },
    // The class, not the instance: a command that declares NO positional must reject one rather than
    // ignore it. `align doctor oops` exited 0 on real 0.1.4 (verified 2026-08-20). The unit-level
    // pin walks the live command tree so a command added tomorrow is covered
    // (cli/test/no-silently-discarded-arguments.test.ts); this is the same property through the real
    // binary, where the exit code is produced by `index.ts`'s mapping rather than asserted on an
    // exception object.
    { run: 'doctor oops', expect: { exit: 2, stderrContains: 'too many arguments' } },
    // `doctor` with no stray argument still works and is still advisory-only (exit 0 even on a repo
    // with real findings) — so the refusal above is about the ARGUMENT, not about doctor being
    // broken by this scenario's setup.
    { run: 'doctor', expect: { exit: 0 } },
  ],
};
