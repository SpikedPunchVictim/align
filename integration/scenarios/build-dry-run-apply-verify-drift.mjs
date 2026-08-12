// ADR 025 §7 `build` row: "dry-run (writes nothing); --apply; --verify after a doc edit" — the
// invariant table's "dry-run leaves the tree untouched; --verify goes red on drift" made
// executable. `write-architecture-rules-doc-with-fenced-rule` seeds a real ADR 011 tier-1 fenced
// ```align block (`{"kind":"arch.no-dependency","from":"core","to":"common"}`) — align's OWN
// deterministic doc-compile pipeline picks this up with no MCP client involved, unlike the plain
// prose `mcp-propose-rules-baseline-gate.mjs` uses.
export default {
  id: 'build-dry-run-apply-verify-drift',
  project: 'nest',
  description: 'align build dry-run writes nothing; --apply writes generated-rules.json + rules.lock.json; --verify goes red after a doc edit.',
  // ADR 026: `build --apply` is one of ADR 026's own named write commands
  // (docs/adr/026-declared-write-sets.md:7-8: "`build --apply` rewrites `align.config.ts`'s note
  // block and three `.align/` artifacts"). Traced against `writeBuildArtifacts`
  // (commands/build.ts) — same three new `.align/` paths and the same `docs/ARCHITECTURE-RULES.md`
  // mutation-created doc as mcp-propose-rules-baseline-gate.mjs, since both scenarios exercise the
  // identical shared write function. `build` (dry-run) and `build --verify` write nothing; the
  // refused `build --apply` (no `--accept-new-into-baseline`) also writes nothing (ADR 006
  // consent doctrine — same "refuses before any write" shape as ADR 024's MCP gate).
  tags: ['destructive'],
  writeSet: [
    'package.json',
    'package-lock.json',
    'align.config.ts',
    'CLAUDE.md',
    '.gitignore',
    '.align/baseline.json',
    '.align/version.json',
    'docs/ARCHITECTURE-RULES.md',
    '.align/generated-rules.json',
    '.align/rules.lock.json',
    '.align/last-build-report.md',
  ],
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' } },
    { mutate: 'write-architecture-rules-doc-with-fenced-rule' },
    { snapshot: 'before-build' },
    // Dry run: writes nothing at all under .align/ (still no rules.lock.json/generated-rules.json).
    { run: 'build', expect: { exit: 0, stdoutContains: 'Dry run only — nothing written' } },
    { assert: { kind: 'exists', file: '.align/generated-rules.json', equals: false } },
    { assert: { kind: 'exists', file: '.align/rules.lock.json', equals: false } },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'before-build' } },
    // --apply: the fenced rule adds a real new violation (core->common), so a plain --apply (no
    // --accept-new-into-baseline) refuses per ADR 006 — writes nothing (same consent doctrine
    // `align init`'s --accept-existing enforces).
    { run: 'build --apply', expect: { exit: 1, stdoutContains: '--accept-new-into-baseline' } },
    { assert: { kind: 'exists', file: '.align/generated-rules.json', equals: false } },
    { run: 'build --apply --accept-new-into-baseline', expect: { exit: 0, stdoutContains: 'Wrote .align/generated-rules.json' } },
    { assert: { kind: 'exists', file: '.align/generated-rules.json', equals: true } },
    { assert: { kind: 'exists', file: '.align/rules.lock.json', equals: true } },
    { snapshot: 'after-apply' },
    { run: 'build --verify', expect: { exit: 0, stdoutContains: 'OK — doc and generated-rules.json match the lockfile' } },
    { run: 'check --frozen-rules', expect: { exit: 0 } },
    // Drift: edit the doc after the lockfile was built — --verify (and check --frozen-rules) must
    // go red; the lockfile/generated-rules.json themselves are untouched by the edit alone.
    { mutate: 'edit-architecture-rules-doc' },
    { run: 'build --verify', expect: { exit: 1, stdoutContains: 'doc-drift' } },
    { run: 'check --frozen-rules', expect: { exit: 1 } },
    { assert: { kind: 'fileUnchanged', file: '.align/generated-rules.json', since: 'after-apply' } },
  ],
};
