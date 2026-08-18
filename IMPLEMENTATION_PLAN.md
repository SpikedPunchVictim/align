# align — Implementation Plan (forward roadmap, post-v0.1.3)

This is the **forward** plan. The arch-first v1 that built align's oracle, DSL/IR, TypeScript plugin,
baseline, MCP server, `align build`, and the BYOK agent loop is **complete and shipped** (v0.1.3) —
its full staged record is archived verbatim at [`history/07.05.26/IMPLEMENTATION_PLAN.md`](history/07.05.26/IMPLEMENTATION_PLAN.md).
Do not re-litigate that work here.

**Authoritative state lives in the repo, not this file:** `ARCHITECTURE.md`, `docs/adr/001–020`,
`docs/proposals/`, and the evidence under `docs/evidence/`. Read those before acting.

**Two parallel tracks — this file is the rules track.** This plan tracks **net-new rules and
capabilities** (public-surface inference, deep-import, `@internal`, semantic-boundary facts). The
**adoption / legibility track** — making align keep talking after day one, without new rule kinds —
lives in [`docs/adr/proposals/deep-import-provenance/reconciled-build-order.md`](docs/adr/proposals/deep-import-provenance/reconciled-build-order.md): the
deps-not-installed false-green fix (#1), the baseline-delta ratchet (#2), the ungoverned-edge gap
report (#3, ADR 019), the deep-import advisory (#4, ADR 020 — the shipped form of Stage 1 below), and
`align init` detection robustness (#5a). Items #1–#5 are **resolved there** — do not re-plan them here.

**Doctrine (unchanged):** arch-first, **promotion-on-evidence** — nothing ships from the Design
Reserve without repo-measured need; landscape/market suggestions are not evidence. Implementation is
done by Sonnet subagents against a signed-off ADR; coding standards are
`/Users/spikedpunchvictim/temp/enterprise-apps/CODING_BEST_PRACTICES.md`. Present deliverables and
wait for explicit sign-off before starting the next stage.

**Evidence base for this roadmap:** the PR-research at
`/Users/spikedpunchvictim/temp/enterprise-apps/pr-research/` (3,000 review comments + 288K commit
subjects, mined + Fable-reviewed) established that align's un-owned lane is *structural surface /
boundary* issues, and ranked the forward candidates. That research motivates Stages 0–2 below.

---

## Stage 0: Public-surface inference (ADR 016)

**Goal**: infer each workspace package's public entrypoint(s) and barrel-reachable public surface —
without requiring declared `exports`/`@public`/`@internal` metadata — as the prerequisite the
`@internal` and deep-import rules consume.

**Success Criteria**: pure algorithm produces a graded `PackagePublicSurface`
(`declared | inferred-unique | inferred-none`); validates against independent ground truth on both
tooled and untooled repos.

**Status**: ✅ **BUILT (pure algorithm), 2026-07-20.** `types/publicSurface.ts` +
`surface/inferSurface.ts` (core) + `entrypoint.ts` (plugin-typescript). Two-round falsification
(`docs/adr/proposals/public-surface-inference/surface-inference-spike/SPIKE_REPORT.md`) held against the real modules: backstage
99.68% precision / 99.95% recall; nest inferred-path 100%/100% vs published npm `.d.ts`; langchain
`./output_parsers` regression PASS. core 275→298 tests, plugin-typescript 44→57, dogfood green.
**Still promotion-gated (NOT built):** the `.align/public-surface.json` persisted artifact,
`align surface infer` CLI, confirmation-gate UX — see Stage 3.

---

## Stage 1: Deep-import convention check (ADR 020) — ✅ SHIPPED, rescoped

**Goal (as built)**: flag cross-package imports reaching past a package's surface into a
`src`/`dist`/`lib`/`internal` subpath segment — the strongest market-confirmed net-new signal in the
PR-research, needing no symbol layer beyond the scanner's existing edges.

**Status**: ✅ **SHIPPED as a `doctor` advisory (ADR 020, reconciled-build-order #4).** Deliberately
RESCOPED from the rule-kind design this stage originally described — the changes are the point, not a
gap:
- **Not a rule kind.** The placebo test (`docs/adr/proposals/deep-import-provenance/deep-import-provenance-probe/`) cut the
  `exports`-aware machinery (~2% swing in both samples) and measured repo-dependent precision (~31% on
  vscode) below ADR 008's blocking bar. It ships advisory-only — `computeDeepImportHits` +
  a `doctor` advisory (the #3 shape) — **not** IR + evaluator. First-class `arch.import-provenance` is
  held in **Design Reserve** behind a blocking-readiness + precision-with-allowlist trigger.
- **Manifest-join / phantom-dependency is OUT**, not "folded in" as the original text assumed —
  contested (3/10, owned by depcheck/knip), scoped out of ADR 020.
- **`exports`-wildcard respect deferred** with Arm B (the exports-aware machinery); a `**`-scoped
  `knownPublicDeepImports` allowlist covers the measured vendor-convention FP class instead.
- Reads `edges + externalEdges + uncertain` (the false-quiet fix: unresolved deep imports route to
  `uncertain` in uninstalled repos). Live: n8n 178 hits, vscode 18 (`@vscode/prompt-tsx` ×12).

---

## Stage 2: `@internal` / public-surface-leakage rule

**Goal**: flag a symbol that is `@internal` (or matches an internal-naming convention) yet is
publicly reachable through a package barrel — consuming Stage 0's inferred surface. Autofix gates on
the confidence grade: `inferred-none` blocks (unsafe to rewrite), `inferred-unique`/`declared` allow.

**Success Criteria**: reproduces the spike's transitive-leak finding (a 2-hop `@internal` escape the
one-hop detector missed); FP rate acceptable on a hand-checked sample; autofix is diff-only
(introduced-in-working-diff), suggest-only at HEAD (per Fable round-2 §2).

**Tests**: the backstage `InternalCookieAuthRedirect`-class transitive leak flags; a sibling-importable
`@internal` (intentional) does not become a false positive.

**Status**: Not Started — its own ADR, gated on a repo-measured FP assessment. (Originally sequenced
"after Stage 1," but Stage 1 shipped as a `doctor` advisory with **no rule-kind machinery to inherit**
— so this is now an *independent* decision consuming Stage 0's inferred surface directly, not a
follow-on from Stage 1.) The PR-research shows this rule is market-mismatched in untooled repos (they
don't write `@internal`); it is the tooled-repo case. If it graduates, it is the first real consumer
of Stage 0's `PackagePublicSurface` and a candidate to co-establish the reserved
`arch.import-provenance` rule kind (Stage 1's Design-Reserve half).

---

## Stage 3: Surface persistence + `align surface infer` (promotion-gated)

**Goal**: the deferred half of ADR 016 — persist the inferred surface as a committed, human-confirmed
`.align/public-surface.json` with a re-infer/diff story, so a downstream autofix conditions on a
stable, reviewed signal.

**Success Criteria (promotion trigger, not yet met)**: (a) a real repo where a stale/committed surface
artifact demonstrably prevents a wrong autofix, OR a downstream rule ADR that needs the persisted
signal; AND (b) a fixture that fires `barrel-cycle` / `unresolvable-reexport` (the real run surfaced 4
benign `unresolvable-reexport` cases — asset-file subpath exports + a package dir named `build` — real
material for that fixture).

**Status**: Not Started — do NOT build until (a) is evidenced. Building the persistence layer ahead of
a demonstrated need is the sequencing-not-de-risking mistake the Fable reviews flagged.

---

## Stage 4: Semantic-boundary facts (probe-first)

**Goal**: the one actionable item from external feedback — boundaries defined by code traits
(`extends BaseRepository`, a decorator, `export`s a `FastifyPluginAsync`), not just path globs.

**Approach (per the ADR-004 external-edges precedent)**: enrich the existing compiler-API scan pass
with cheap syntactic facts (`extends`/`implements`/decorator names) onto graph nodes **while the AST
is already in hand** — NOT a second AST engine (oxc/swc), which collides with ADR-004's measured
"scan-and-discard" decision. Expose the facts to `custom.host` predicates first; a first-class rule
kind only if evidence warrants.

**Success Criteria (promotion trigger, not yet met)**: one repo-measured case (kluster or n8n) where a
trait boundary catches something path components structurally cannot express.

**Status**: Not Started — spike-first. No production code until the measured catch exists.

---

## Design Reserve (forward)

Held with triggers, not committed (see `docs/proposals/rule-expansion-evaluation.md`):
- **Rule A as a health metric** — `export *`-at-entrypoint count as an advisory, unlocked by Stage 0's
  surface layer; demoted from hard rule (spike: can't distinguish curated barrels from creep).
- **`fixHint` remediation recipes** on the `align explain` prose surface (the actionable residue of the
  external feedback's "explain it to the agent" — align already ships the payloads per ADR 007).
- **Version-drift / standalone manifest checks** — rejected on evidence (0.07% of commits; owned by
  syncpack/pnpm catalogs). The phantom-dep half was considered for Stage 1 but scoped **out** of ADR
  020 (contested 3/10; owned by depcheck/knip); it has no current home.
- **First-class `arch.import-provenance` rule kind** — the blocking version of Stage 1's deep-import
  advisory. Trigger: an adopter wanting the blocking ratchet on a workspace monorepo AND ≥80% measured
  precision with the allowlist on a vscode-class repo (ADR 020).
- **`manifestField` component classification (ADR 017 Part B)** — DEFERRED on evidence
  (`docs/evidence/manifest-field-classification-probe/`): path enumeration reaches ~100% (an
  ergonomics gain, not a capability gap), ~1 live catch on the exemplar, 1/10 prevalence. Trigger: a
  second non-backstage repo with a manifest-field classification convention and no bespoke tooling.

## Key risks
| Risk | Mitigation |
| --- | --- |
| Surface confidence contract degenerate in untooled market | Resolved: graded contract; nest's `inferred-unique` scored 100% (ADR 016 Round-2 amendment). |
| Building persistence/rules ahead of evidence | Stages 3–4 are promotion-gated with explicit triggers; each new rule gets its own ADR. |
| `@internal` rule market-mismatch | The untooled market is served by the shipped deep-import advisory (Stage 1); the `@internal` rule is documented as the independent tooled-repo case, gated on its own FP assessment. |
