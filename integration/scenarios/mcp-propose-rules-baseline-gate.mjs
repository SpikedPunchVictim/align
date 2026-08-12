// ADR 025 Tier-1 #4 (ADR 024): `align_propose_rules`'s `accept_new_into_baseline` gate, driven end
// to end over a REAL `align mcp` child process speaking genuine MCP JSON-RPC (`lib/mcp-client.mjs`)
// — not the in-process `InMemoryTransport` the CLI's own unit tests use
// (`packages/cli/test/mcp-baseline-gate.test.ts`), which never exercises the actual `align mcp`
// subcommand or its stdio framing. `write-architecture-rules-doc` seeds a minimal
// `docs/ARCHITECTURE-RULES.md` (the tool's `doc_path` default) — its prose content doesn't ground
// the submitted proposal (`groundFragment` grounds by selector against the live component
// registry), it only needs to exist so the tool doesn't refuse with "Doc not found".
//
// `arch.no-dependency:core->common` (nest's real component pair, `projects/nest.mjs`'s `violation`
// descriptor) is a genuine new violation the FIRST time it's proposed — nest's own default
// `align.config.ts` (from `init`) has no rule forbidding it yet, so accepting it into the baseline
// is a real ADR-024-gated write, not a no-op with nothing to refuse.
export default {
  id: 'mcp-propose-rules-baseline-gate',
  project: 'nest',
  description:
    'align_propose_rules over real MCP stdio: accept_new_into_baseline:true is refused with allowBaselineFromMcp ' +
    'absent/false and the on-disk baseline is unchanged; permitted once align.config.ts opts in (ADR 024).',
  // Verified empirically (2026-08-10): ADR 024 names this precisely — a real 0.1.4 has NO gate at
  // all, `accept_new_into_baseline: true` writes the baseline unconditionally. Real, reproducible
  // red on a published version, the same calibration discipline as the other expectFailOn scenarios.
  expectFailOn: ['0.1.4'],
  // ADR 026: `accept_new_into_baseline` is the exact write ADR 024's gate exists to guard — a
  // consequential, consent-gated baseline write reachable over MCP. Traced against
  // `writeBuildArtifacts` (commands/build.ts, shared by `align build --apply` and this MCP tool):
  // `.align/generated-rules.json`, `.align/rules.lock.json`, `.align/last-build-report.md` are new
  // this scenario; `align.config.ts`'s note block is re-spliced (COMMON set already covers the
  // path); `.align/baseline.json`/`.align/version.json` get the accepted violation (COMMON set).
  // `docs/ARCHITECTURE-RULES.md` is the `write-architecture-rules-doc` mutation's own new file. The
  // FIRST mcpCall is refused before any artifact write (ADR 024 decision 2) — nothing new from it.
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
    { mutate: 'write-architecture-rules-doc' },
    { snapshot: 'after-init' },
    {
      mcpCall: {
        tool: 'align_propose_rules',
        arguments: {
          doc_path: 'docs/ARCHITECTURE-RULES.md',
          proposals: [
            {
              section: 'core-isolation',
              fragment: { kind: 'arch.no-dependency', from: 'core', to: 'common' },
              sourceLineRange: { startLine: 5, endLine: 5 },
              sourceQuote: '`core` must not depend on `common`.',
            },
          ],
          apply: true,
          accept_new_into_baseline: true,
        },
      },
      // Refused before any artifact write — names the CLI equivalent, per ADR 024's decision 2.
      expect: { isError: true, textContains: 'allowBaselineFromMcp' },
    },
    { assert: { kind: 'exists', file: '.align/generated-rules.json', equals: false } },
    { assert: { kind: 'fileUnchanged', file: '.align/baseline.json', since: 'after-init' } },
    { mutate: 'enable-allow-baseline-from-mcp' },
    {
      mcpCall: {
        tool: 'align_propose_rules',
        arguments: {
          doc_path: 'docs/ARCHITECTURE-RULES.md',
          proposals: [
            {
              section: 'core-isolation',
              fragment: { kind: 'arch.no-dependency', from: 'core', to: 'common' },
              sourceLineRange: { startLine: 5, endLine: 5 },
              sourceQuote: '`core` must not depend on `common`.',
            },
          ],
          apply: true,
          accept_new_into_baseline: true,
        },
      },
      expect: { isError: false, textContains: '"applied": true' },
    },
    { assert: { kind: 'exists', file: '.align/generated-rules.json', equals: true } },
    { assert: { kind: 'fileChanged', file: '.align/baseline.json', since: 'after-init' } },
  ],
};
