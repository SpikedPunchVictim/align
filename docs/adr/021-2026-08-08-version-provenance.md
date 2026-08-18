# ADR 021: Version Provenance and Skew Detection

**Status**: Accepted

## Context

align compares versions in three places, and all three encode the same unexamined assumption:
**the same version string means the same behaviour.** The full-codebase audit of 2026-08-03
(`.agents/research/2026-08-03-bug-hunt-full-codebase.md`) falsified that assumption concretely —
of the 15 bugs it fixed, **four changed violation fingerprints**, meaning a baseline written by
one build stops matching under another. Nothing in any persisted artifact records which build
wrote it, so neither align nor the user can tell a fingerprint change from a real code change.

The three sites, each verified in current source:

**Gap 1 — skew detection does not resolve the way Node resolves.**
`packages/cli/src/version-skew.ts:23` reads exactly one path:
`path.join(rootDir, 'node_modules', '@spikedpunch', 'align-core', 'package.json')`. Node resolves
`node_modules` by walking *up* the directory tree. In a hoisted monorepo — pnpm/npm workspaces,
the common layout for the repos align targets — `align-core` lives at the workspace root, not in
the package being checked. The lookup fails, `detectVersionSkewAdvisory` returns `undefined`, and
a genuine skew is reported as no skew. This is a **false negative in the detector whose entire
job is catching false results**, which makes it the most self-defeating of the three.

**Gap 2 — persisted artifacts carry a write *time* but no producer *identity*.**
Every `.align/` artifact records **when** it was written and none records **what wrote it**:
`generated-rules.json` has `generatedAt` (`build/schema.ts:96-101`), `rules.lock.json` has
`builtAt` (`:123-130`), `ruleset-ir.json` has `exportedAt` (`:147-152`), and `baseline.json` —
`z.array(baselineEntrySchema)`, a bare array (`baseline/schema.ts`) — has no envelope at all and
so records nothing about itself. `irVersion` does not close the gap: it is the *schema* contract,
a `z.literal('1')` that stays `'1'` across every behavioural change align will ever make.

**No `.align/` artifact is guaranteed to exist**, which is what decides where the fix lives.
`generated-rules.json` and `rules.lock.json` appear only if the repo opts into doc-driven rules
(`align build --apply`, ADR 011). `ruleset-ir.json` appears only if someone explicitly runs
`align export-ir` — `buildExportedRuleset` has exactly one caller, `commands/export-ir.ts:36`,
and nothing invokes it automatically. `baseline.json` may be absent entirely (a missing file reads
as `[]`, `align-dir.ts:78`) or present-but-empty — `align init` writes `[]` on a green repo
(`commands/init.ts:155`), which is the bare-array-with-no-envelope problem in its purest form: a
file that exists, records nothing about itself, and has nowhere to put anything. Provenance
recorded *inside* an artifact is therefore provenance a repo may simply not have.

This gap is consequently **not fixed here.** It is delegated to ADR 022's `.align/version.json`,
the one record align can write unconditionally. Stamping individual artifacts is held in the
Design Reserve below.

**Gap 3 — `stale-skill` is version-string-only.**
`packages/cli/src/commands/doctor.ts:80-100` parses a version marker out of the installed
`SKILL.md` and compares it to `ALIGN_VERSION`. A skill re-rendered at the same version — the
normal case during development, and any patch that changes skill content without a version bump —
is undetectable. The repo already has the right pattern for this: `rulesLockSchema.docContentHash`
(`build/schema.ts:126`) hashes content rather than trusting a version.

These are one root cause, not three bugs, which is why they are one ADR.

## Decision

**Invariant: a version comparison must resolve the same way the runtime resolves, and the align
version that wrote a repo's state must be recorded in exactly one place — never two that can
disagree.**

The second clause is as load-bearing as the first. Two records of the same fact, updated by
different commands on different schedules, is not redundancy — it is a guaranteed future
contradiction with no tiebreaker. `.align/version.json` (ADR 022) is that one place.

Applied to the three gaps:

1. **Skew detection walks up.** `detectVersionSkewAdvisory` resolves `@spikedpunch/align-core`
   by walking parent directories from `rootDir`, mirroring Node resolution, and reports the
   resolved path in the advisory so a user can see *which* install it compared against. Absence
   at every level stays `undefined` (a missing core is a config-load error, not a skew) — that
   existing behaviour is deliberate and unchanged.

2. **Artifact provenance is delegated to `.align/version.json` (ADR 022), not stamped into
   artifacts.** No artifact is guaranteed to exist, so no artifact can be the record.
   `version.json` is written by every command that writes *any* `.align/` artifact — a strictly
   larger set than the writers of any single artifact, and the closest thing to a guarantee
   available (ADR 022 specifies it exactly; a read-only `check` writes nothing, by design). It is
   the single place, and nothing else records the same fact.
   **`exportedRulesetSchema` is deliberately left unchanged by this ADR.**

3. **`stale-skill` gains a content hash. The determinism prerequisite has been discharged.**
   A content hash over a non-deterministic render would nag on every `align doctor` run forever —
   strictly worse than the version-only check it replaces — so this was gated on proof rather than
   assumption. **The proof was run and it passes**: `packages/cli/src/skill/` contains no `Date`,
   `Math.random`, `process.env`, or locale-dependent call, and `renderSkillMarkdown('all', …)`
   produces byte-identical output across three separate processes (sha256 `c837e3ef199ca6a4`,
   16973 bytes, 2026-08-08). Add the hash following the `docContentHash` pattern
   (`build/schema.ts:126`). The written file adds only static frontmatter and
   `renderVersionStamp(ALIGN_VERSION)`, so the hash must be computed over the rendered body
   *before* the version stamp is applied, or it will churn on every version bump for no reason.

## Alternatives considered

**Bump `irVersion` on every behavioural change.** Rejected: `irVersion` is the schema contract.
Bumping it forces a parse break on consumers whose parsing is entirely unaffected, and conflates
"the shape changed" with "the producer changed" — two questions with different answers.

**Make version skew a hard gate failure rather than an advisory.** Rejected: it contradicts the
gate model (ADR 008), and skew is frequently benign (align dogfooding itself, a deliberate local
build). The advisory's job is to make a silent behaviour difference visible, not to block.

**Embed a behaviour hash of all matchers/evaluators in the IR.** Held in the Design Reserve. It
would detect the actual thing we care about — behavioural difference rather than version
difference — but there is no evidence yet that version stamping is insufficient, and the hash has
the same determinism hazard as gap 3. Promote only if a version-stamped artifact is observed
diverging.

**Have core read its own `package.json` to self-stamp.** Rejected: core is I/O-free by
construction. Were any artifact stamped later, the version would be passed in as a parameter
alongside the `exportedAt`/`builtAt` value the same call already takes.

**Stamp `alignVersion` into `ExportedRuleset` so the IR is self-describing.** Held in the Design
Reserve, and this is the closest call in the ADR. The argument for it is real: `--out <path>` and
`--ir <path>` (`packages/cli/src/program.ts:124`, `:100`) make the IR **portable**, and ADR 014's
whole shape — export in a trusted checkout, check in an untrusted one — implies it crossing a
boundary. `version.json` cannot follow a file that leaves `.align/`.

Reserved anyway, for two reasons. First, no such flow has been observed: the capability is
designed, its usage is unproven, and building for it now is the "might be needed" trap. Second,
and decisively, an IR stamp would be a **second record of the same fact** — `version.json` and the
IR could disagree about which align touched this repo, with no rule for which wins. One accurate
record beats two that need reconciling.

**Promotion trigger** (record the evidence when it fires): a real flow that consumes a
`ruleset-ir.json` outside the `.align/` directory that produced it. At that point the IR stamp is
provenance for a *travelling artifact*, which is a different fact from "what version wrote this
repo's state" — and two records of two different facts is not duplication.

## Consequences

- The skew advisory starts firing in hoisted monorepos where it was previously silent. Some of
  these are real skews that were being missed; expect an increase in advisory volume that is a
  correction, not a regression.
- **No artifact schema changes.** `exportedRulesetSchema`, `rulesLockSchema`,
  `generatedRulesFileSchema`, and `baselineFileSchema` are all untouched. Gap 2 is closed by a new
  file (ADR 022), not by migrating four existing wire formats — which also means no downgrade
  hazard, since an older align ignores a file it does not know about.
- A `ruleset-ir.json` moved out of `.align/` via `--out` carries no provenance. Accepted
  knowingly; see the promotion trigger above.
- Gap 3 ships a content hash; the determinism gate that could have blocked it was discharged by
  measurement, not waived. Had it failed, the documented outcome would have been a limitation
  rather than a fix. That is recorded here so it is not
  silently re-proposed later as an oversight.

## Evidence

- **Fingerprint churn is real and measurable**: 6 of 207 baseline entries (**2.9%**) on
  `test-apps/n8n` stopped matching across this upgrade, with `baselineDebt {previous: 207,
  current: 201, delta: -6}`. All 207 are `arch.no-cycles:repo`, whose fingerprint is built from
  the cycle's edges (`packages/core/src/rules/evaluators.ts:164`), so BUG #9's BFS rewrite
  necessarily moves it. Measured 2026-08-08; see ADR 022 for the full measurement and its limits.
- **Provenance is unknowable today, demonstrated rather than asserted**: the `test-apps` baselines
  carry no version field, and their shapes disagree — `kluster` has `contentFingerprint` on 8/8
  entries while `n8n`, `directus`, `fluxify`, and `otel-js` have it on 0/N. Different builds wrote
  them; nothing records which. The `v0.1.4` tag is dated 2026-07-28 and the baselines' mtimes are
  2026-07-11 to 07-15, so they predate even the last release.
- **The line-number doctrine is the precedent this generalizes**: `baseline/fingerprint.ts:8-9`
  ("never line numbers") already establishes that fingerprint stability is a deliberate,
  documented contract; `rules/host-rules.ts:74-84` records what it costs and how to work with it.
  Version provenance is the same contract applied to the artifact rather than the entry.
- Audit report: `.agents/research/2026-08-03-bug-hunt-full-codebase.md` (BUG #17 fixed the MCP
  surface's missing advisory; gaps 1–3 were deferred there and are resolved here).
