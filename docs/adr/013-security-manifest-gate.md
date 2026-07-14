# ADR 013: `security.manifest` Gate

**Status**: Accepted

## Context

The plan's full gate stack (`parse → format → lint → types → architecture → security → tests`, ADR 008)
names `security` as a v1-fixed category with no v1 rule kind — `security.secrets` and `security.tool` were
reserved discriminants only, unspecified, pending evidence (`docs/ir-schema.md`). `docs/proposals/rule-
expansion-evaluation.md` §B.5 Stage B-1 (user-approved) commissioned a Stage-S-shaped probe — offline manifest
rules against align itself, `test-apps/kluster`, and `test-apps/n8n` — before promoting anything, per the
project's promotion-on-evidence doctrine. The probe (`docs/evidence/manifest-security-probe/MANIFEST_PROBE_REPORT.md`, 2026-07-12) measured
seven candidate rule checkers; this ADR promotes the two the probe's own evidence supports and rejects/defers
the rest.

**Measured evidence (all numbers from the probe report, none estimated):**

- **Rule 7 (new-dependency-since-baseline)** is the probe's strongest result: a genuine historical catch on
  align's own git history — `@anthropic-ai/sdk` entering the dependency tree when `packages/agent` was built
  in Stage 4 (HEAD~20 window: 7 findings, 6 of them one same-commit new-package event) — plus mechanism-proof
  simulations on kluster (`vitest` correctly flagged) and n8n (`zx` correctly flagged), zero false positives
  across all three repos.
- **Rule 1 (dependency source hygiene)** found 3/3 hand-verified-real, zero-false-positive cases on n8n (the
  probe's own stress test): `xlsx` pinned to a SheetJS CDN tarball (`https://cdn.sheetjs.com/...` — SheetJS
  stopped publishing past 0.18 to npm) and `wa-sqlite` pinned to an unreleased git commit
  (`github:rhashimoto/wa-sqlite#779219540f66cecaa159da32b3b8936697ba10a7`). An `npm:`-alias specifier present
  in the same n8n tree correctly did **not** false-positive (it still resolves through the registry).
- **Rule 2 (install-script exposure)**: real signal (0/12 hand-verified scripts across align+kluster were
  actually suspicious — all legitimate native-binary-fetch/codegen patterns) but a weak triage mechanism
  (name-allowlist classification left 45% of kluster's real findings "unclassified") and, critically, **an
  unmeasurable result on n8n** — `node_modules` was never installed on the probe machine, so the true
  install-script count for n8n's ~3,500-entry dependency tree is unknown, not zero. This is the doctrine
  tension resolved below.
- **Rule 3 (version-pinning policy)**: zero findings across 5,594 real lockfile-managed specifiers in three
  repos, including a 3,500-line-item production monorepo (n8n). Not "low priority" — empirically dead.
- **Rule 4 (lockfile↔manifest drift)**: 100% false-positive rate pre-fix (a `peerDependencies` comparison
  bug), 0/0/0 post-fix — clean once corrected, but zero positive evidence of what a real hit looks like.
- **Rule 5 (registry provenance)**: found the same two n8n packages Rule 1 already found — 100% redundant.
- **Rule 6 (dependency-confusion, offline half)**: 12/12 raw "unscoped name" findings, 0/12 survived a
  second-order check (is the name actually reachable via a non-`workspace:` reference anywhere) — the
  offline-only signal is too coarse to be actionable on its own.

## Decision

**Promote two rule kinds**, both under a new `security` gate:

1. **`security.manifest.source-hygiene`** — any dependency specifier resolving to a
   `git`/`git+`/`github:`/`gitlab:`/`bitbucket:`/`http(s):`/`file:`/`link:` source (not a registry version
   range, not `workspace:`, not an `npm:` alias) is a `Violation`. `file` is the declaring `package.json`;
   `depName`/`specifier`/`sourceType` are structured fields (ADR 007 — no prose duplication).
2. **`security.manifest.new-dependency`** — every current runtime (`dependencies`) and dev
   (`devDependencies`) dependency, name-level, per declaring manifest, is fingerprinted on every run.
   **Re-expressed through align's existing baseline-consent machinery (ADR 006), not a git-history diff**:
   the probe's Rule 7 used `git show`/`git diff` to size the signal, but the shipped evaluator is stateless —
   it has no notion of "since when." `align init` / `baseline accept` seeding "every dependency present today"
   turns the day-one baseline into "nothing," so only a dependency whose (manifest path, name) fingerprint the
   baseline has never seen shows red. This is doctrinally identical to how every other align rule kind
   handles pre-existing debt — it does not require, and does not use, git history at all.

**Name-level, not version-level, for both rules — deliberate, not a shortcut.** A version-level
`new-dependency` gate would fire on every routine dependency-version bump (Renovate/Dependabot PRs), which
the probe's own noise-assessment doctrine (measured false-positive rates driving every rejection above)
would treat as an unacceptable false-positive rate. `security.manifest.source-hygiene`'s fingerprint is
similarly name-level (declaring manifest + dependency name, never the specifier value) so a git-ref bump on
an already-reviewed non-registry dependency doesn't reset consent. Version-level gating is a **documented
follow-up**, not built here.

**Fingerprint design**: `computeFingerprint([kind, ruleId, manifestFile, depName])` — no specifier value, no
line number. Stable across manifest reformatting and dependency-value churn; distinct per (manifest, name)
pair, matching ADR 006's "line numbers break under reformatting" doctrine extended to the one new axis
manifest rules introduce (a dependency's specifier can legitimately change without the finding's identity
changing).

**Scan-domain placement: `@spikedpunch/align-plugin-typescript`, not `@spikedpunch/align-core`, not a new `plugin-manifest`
package.** The probe explicitly flagged this as an open design question — package.json/pnpm-lock.yaml text
is a different input class from `plugin-typescript`'s TS-compiler-API source scanning, so it isn't "just
another file type" for the existing `Scanner`. It stays inside `plugin-typescript` rather than becoming a
fourth package because (a) it is Node/pnpm-ecosystem-specific — the same "zero framework dependencies"
argument (ADR 001/004) that keeps `plugin-typescript` itself separate from core would apply equally to a
new package, at the cost of one more `package.json`/build target for zero isolation benefit with exactly one
consumer; and (b) it reuses `workspace.ts`'s existing `loadWorkspacePackages` — a genuine "don't duplicate"
opportunity a separate package would have to either re-implement or import cross-package for one shared
helper. `@spikedpunch/align-core` owns only the `ManifestScanner` injection interface (mirrors `Scanner`/
`LanguagePlugin`) and the pure, I/O-free evaluators (`rules/manifest-evaluators.ts`); the CLI composition
root injects `plugin-typescript`'s `NodeManifestScanner` exactly like it injects `TypeScriptPlugin` — core
never imports `plugin-typescript` directly (ARCHITECTURE.md §5).

**Gate wiring: `dependsOn: []`, always runs, independent of `architecture`.** Per ADR 008's always-run
carve-out (originally written for `format`/`lint`/`security.secrets`): a manifest scan reads only
`package.json`/`pnpm-lock.yaml`, never TypeScript source, so there is no reason a TS-parse failure should
mask it or vice versa. `GateOrchestrator.check()` computes the `security` gate before attempting the
TypeScript scan, so it still produces a real result (including `red`) even when `parse` errors.

**No network, no `node_modules` required for these two rules** — both read only already-committed manifest
text (root + workspace `package.json`, `pnpm-lock.yaml`'s `importers:` section for lockfile-resolved
specifiers, needed so a `catalog:`-managed dependency's real specifier is visible). This preserves ADR 004's
"`pnpm install` is a non-prerequisite for seeing a repo's architecture" invariant for the manifest domain too.

## The CI/CD install doctrine (user decision, recorded verbatim in spirit)

The probe's single most important finding for this promotion decision is a **negative** result: Rule 2
(install-script exposure) could not produce a trustworthy answer on n8n, because `node_modules` was never
installed on the probe machine, and pnpm's lockfile format carries no install-script metadata of its own
(confirmed by grep across all three real lockfiles). ADR 004 already establishes that align "must not require
`pnpm install` before it can see a repo's architecture" for the existing rule kinds — but install-script
detection, as scoped by the evaluation doc that commissioned this probe ("post-install only, offline"),
silently assumes the opposite: that installation already happened. Shipping it as designed would have meant
either a silent, wrong "0 install scripts" on any repo align has never had installed locally (a false-zero,
this project's own doctrine treats a false-green/false-zero as a severity-zero bug class — ADR 008's
amendment, the three prior false-green fixes) or an undocumented precondition nobody told the user about.

**Resolution, as decided by the user**: install-dependent manifest rules (install-script exposure and any
future rule in this family that genuinely needs a populated `node_modules`) are a **CI/CD-context concern**
— the pipeline that runs `align check` for that purpose is expected to run a real `pnpm install` first, same
as it already must for `pnpm test`/`pnpm build` to mean anything. **When `node_modules` is absent, such a
rule must report an explicit `skipped`/advisory state naming exactly what couldn't be checked and why — never
a false zero, never a silent clean pass.** This is a doctrine statement for the gate as a whole, not just for
the two rules promoted here: `security.manifest.source-hygiene` and `security.manifest.new-dependency` are
promoted specifically *because* neither needs `node_modules` at all (both read manifests + lockfile only) —
this doctrine exists to bind whichever rule joins them next that does.

## Alternatives rejected

- **Version-pinning policy** (probe Rule 3). Rejected on evidence, not judgment: zero findings across 5,594
  real specifiers in three repos, one a 3,500-line-item production monorepo. As clean a "no repo-demonstrated
  demand" verdict as this project's promotion doctrine could ask for — n8n's `catalog:` mechanism (66% of its
  specifiers) already centralizes pinning at the workspace level, and `.npmrc`'s `save-exact=true` plus a CI
  check already covers what demand exists.
- **Registry-URL allowlisting / resolved-lockfile-provenance** (probe Rule 5). Rejected: 100% redundant with
  `source-hygiene` on the only repo where it fired (the same two n8n packages, found from the lockfile-
  resolution side instead of the manifest-specifier side). The evaluation doc's own pre-probe verdict —
  "wrap `lockfile-lint`, don't build" — is confirmed, not just asserted. Not worth a bespoke align
  implementation for zero new signal.
- **Offline dependency-confusion exposure** (probe Rule 6), as originally scoped. Rejected as-is: the naive
  "unscoped package name" signal is 12/12 technically-true but 0/12 exploitable-today by the offline half
  alone (every internal reference in all three repos resolves via `workspace:`, never a bare name that could
  be confused with a public package). If ever built, it needs `unscoped AND private:true AND referenced via
  a non-workspace specifier` narrowing — and even that narrower signal's real value is the network half
  (does the name already exist, squatted, on the public registry) that the evaluation doc explicitly scoped
  out of this project. Not promoted, not reserved with a shape — scoped out.
- **Lockfile↔manifest drift** (probe Rule 4). Held, not rejected: the corrected (peerDependencies-aware)
  version is clean but the probe supplies zero positive evidence of a real hit on any of the three repos.
  Shipping an unexercised rule contradicts the same promotion-on-evidence doctrine as shipping a noisy one
  would — needs either a fourth repo or a deliberately seeded drift fixture before its own promotion.

## Consequences

- `Category` already included `'security'` in the v1 type union (`docs/core-interfaces.md`, reserved since
  ADR 007/008 fixed the priority-sort ordering) — no `Category` change was needed, only new `RuleIR`/
  `Violation` discriminants.
- `evaluateRule` (the graph-based dispatcher `architecture` already used) returns `[]` for both
  `security.manifest.*` kinds by design, documented inline — they are real `RuleIR` members for DSL/tier-2/
  `align build` round-tripping, but their actual evaluation only ever happens through the disjoint
  `evaluateManifestRule` dispatcher against real `ManifestInventory` data, called exclusively by the
  `security` gate. **Known gap**: `align build`/`align explain`'s generic graph-based impact-delta preview
  therefore under-reports manifest-rule violations (always 0 in that preview) — `align check`'s `security`
  gate remains the authoritative evaluation path. Threading `ManifestInventory` through those preview call
  sites is a follow-up, not built in this promotion.
- `GateOrchestrator`'s constructor gained a fifth, optional `manifestScanner` parameter (default: a no-op
  returning an empty inventory) — every pre-existing caller/test that doesn't author `security.manifest.*`
  rules keeps working unchanged, same injection-default convention as `hostPredicates`.
- Every exhaustive switch the reference-validity amendment (ADR 008) requires extending was extended:
  `evaluateRule`, `componentRefsOf` (`rules/component-refs.ts` — both kinds yield no `ComponentRef`, the
  manifest scan domain has no notion of align's file-classified components), `groundFragment`
  (`build/ground.ts`), `buildViolationMermaid` (`payload/mermaid.ts`), and the CLI's `ruleSelectors`
  round-trip switch (`commands/build.ts`).

## Follow-up ladder

1. **Install-script exposure** (probe Rule 2) — held pending a content-pattern classifier rework (match
   `node-gyp-build`/`prebuild-install`/`node-gyp rebuild`/a fetch-a-prebuilt-binary shim by script *content*,
   not a package-name allowlist that under-classifies 45% of real cases on day one, per the probe's own
   measured design lesson). Ships as an install-dependent rule bound by the CI/CD doctrine above: CI/CD
   context, `node_modules` required, explicit `skipped`/advisory (never a false zero) when absent.
2. **Version-level gating** for `security.manifest.new-dependency` — documented, not built. Would fire on
   every routine version bump; needs its own evidence before promotion, same doctrine as everything else in
   this ADR.
3. **Dependency-confusion, narrowed** (`unscoped AND private:true AND non-workspace-referenced`) — offline
   half only remains low-value without the network half; revisit only alongside a future `align doctor`-class
   advisory that can also do the network query.
4. **Explicitly out of scope, not just deferred**: any network-dependent half of any rule in this family
   (public-registry squatting checks, live registry-provenance verification) — align's zero-network posture
   (this ADR, ADR 004) is a hard boundary, not a sequencing choice.

## Evidence

`docs/evidence/manifest-security-probe/MANIFEST_PROBE_REPORT.md` (2026-07-12) — full measured results across align/kluster/n8n for all seven
candidate rules, cited by number throughout this ADR. `IMPLEMENTATION_PLAN.md`'s Design Reserve promotion log
records the user's approval and the CI/CD install doctrine decision this ADR expands on.
