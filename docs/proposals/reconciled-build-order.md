# Reconciled build order — align's post-day-one usefulness

**What this is.** The forward build order for align's "next usefulness jump," reconciled from three
independent analyses that converged:
1. **Session research** (`pr-research/FINDINGS_CONSOLIDATED.md` + ADRs 016/017/018/019) — PR-comment
   and git-history mining, probes, Fable reviews.
2. **External empirical run** — another model ran `align init → check → doctor` on 8 enterprise repos
   (pnpm/yarn/npm × lerna/nx/turbo). Dominant finding: init baselines cycles → check green → **"align
   has nothing more to say unless the user manually authors layers"** (0 active violations on all 8;
   component auto-detection weak on some — nest=1 component, vscode=6,234 unmapped).
3. **Fable review** of #2 + the "background re-evaluation" idea — corrections folded in below.

**The core problem all three name:** align delivers strong day-one value (baseline the cycles, go
green) and then goes **silent**. The next jump is *post-install ongoing signal* — but decomposed into
three distinct silences, only two of which are problems:
- (a) silence about **ungoverned structure** → fix: the ADR 019 gap report.
- (b) silence about **baselined debt** → fix: a baseline-delta trailer.
- (c) silence about **conforming code** → *not a problem*; correct oracle behavior.

## Corrections that shaped the order (Fable, verified)
- **"Presets = just packaging" is false on the external model's own data.** Presets bind to components
  named `core`/`contracts`; on repos where component detection collapsed (nest=1, vscode=6,234
  unmapped) there is nothing to bind to. **Component-classification robustness is a prerequisite of
  presets, not a side item.**
- **Presets get *baselined* on existing repos** (`init --accept-existing`), so they don't break the
  silence for existing code — they only guard *new* code. The gap report is what surfaces *existing*
  ungoverned structure without gating.
- **Deps-not-installed is a false-green, not a UX nicety.** A green check over a graph missing all
  `node_modules` edges would false-green *any* external-edge rule (core-free-of-framework, provenance).
  Severity-zero class → jumps the queue.
- **Priority: gap report ≥ provenance > presets** (provenance needs no classification and produces
  net-new violations; presets need classification and get baselined).
- **Overclaim corrected:** ADR 016's inferred-surface pass is validated on n=1 untooled repo (nest);
  the reserve condition wants plural. ADR 016/017 are built **on `stage0-surface-inference`, not main.**

## The build order

### 1. Deps-not-installed false-green fix  — *do first, severity-zero*
When external specifiers can't resolve because `node_modules` is absent, emit **one** advisory
("Dependencies not installed — N external specifiers excluded; install for a complete architecture
check") instead of thousands of `unresolvable-specifier` lines, and ensure the verdict cannot read as
authoritative. Unblocks every future external-edge rule from false-greening. Effort: very low.

### 2. Baseline-delta trailer  — *near-free ratchet*
align already computes the baselined count every check. Add a one-line trailer:
`baselined debt: 47 → 45 (−2)`. ~10 tokens, lands in the one channel agents provably read (ADR 009),
converts the day-one baseline from a *silencer* into a *ratchet* (debt only goes down). The cheapest
fix for silence (b). Effort: very low.

### 3. ADR 019 Mode 2 — the ungoverned-edge gap report  — *the real silence-fixer*
Enumerate component import edges **not covered by any existing rule** (edges-minus-ruleset, pure graph,
no git mining — ADR 019 rescoped, co-change cut). Rank by fan-in/edge-weight; exclude composition roots
by explicit `compositionRoots: [...]` declaration. `align doctor`-shaped. Fixes silence (a) for existing
structure. Effort: low (graph-only). Gate: maintainer accept/reject precision.

### 4. Deep-import provenance  — *strongest net-new signal*
`arch.import-provenance`: flag cross-package imports that reach past the declared public surface into
`/src`,`/dist`,`/lib`,`/internal` or an undeclared subpath; respect `exports` wildcards. Keys off
package boundaries + `exports` — **no component classification needed**, so it works on the repos where
presets can't bind. The only recommendation producing net-new violations. Evidence: n8n spike (466 raw
→ ~15-20 est. TP once wildcards respected — an untriaged *hypothesis*, to be triaged, not a measured
rate); vscode same class (`@vscode/prompt-tsx/dist/base/...`). Effort: medium. Needs its own ADR.
**Placebo-test first:** compare the `exports`-aware machinery against a dumb `/src/|/dist/` cross-package
grep before crediting the machinery (the discipline that rescoped ADR 019).

### 5. Contract presets  — *after classification robustness*
Ship generic (never vendored) preset packs on the existing engine: `contracts-purity`,
`core-free-of-framework` (= ADR 017 external selectors, built), `no-cross-layer-test-imports`.
Prerequisite: component-classification robustness (item 5a). On existing repos hits get baselined, so
this guards *new* code, not existing. **Tier the TP bar:** ≥80% TP to ship as advisory/suggestion;
~95%+ (or ship-baselined) to ship as a *blocking* default (ADR 008: a blocking rule at 1-in-5 FP is
trust-destroying).
- **5a. Component-classification robustness** (the prerequisite): improve `align init` component
  detection on non-pnpm/npm setups (nest/vscode collapsed), and the `manifestField` classifier
  (ADR 017 Part B) for convention-based classification. Without this, presets no-op or mis-bind.

### 6. Background periodic re-evaluation  — *DESIGN RESERVE (premature)*
The owner idea: re-evaluate a repo on a cadence / change-delta so align keeps surfacing new findings.
**Verdict: right instinct, wrong mechanism, and premature — the thing being re-evaluated (item 3)
doesn't exist yet.** Once it does, this collapses to:
- a one-line **new-since-acknowledged** trailer on `align check` (the *read* channel — "behind the
  scenes" guarantees no reader, ADR 009 probe-1: available-but-unmandated → zero engagement), keyed off
  a **fingerprint of the component-edge set diffed against the last acknowledged state** (the baseline
  pattern, ADR 006 — *not* a wall-clock timestamp, which doesn't track structure and has no home across
  branches/CI), plus
- a documented **CI/cron cadence for `align doctor`** (needs zero new mechanism).
**Promotion trigger:** ship item 3 first; then an ADR-009-probe-1-style adoption probe (does the
trailer actually get acted on?) before building the acknowledged-state throttle. No daemon, no watcher
(ADR 005 rejected file-watch for v1), no LLM-synthesized suggestions, no co-change drift (ADR 019 cut).

## Status snapshot
| # | item | status |
|---|---|---|
| 1 | deps-not-installed false-green fix | not built — do first |
| 2 | baseline-delta trailer | not built — near-free |
| 3 | ADR 019 Mode 2 gap report | ADR 019 DRAFT (rescoped), unbuilt |
| 4 | deep-import provenance | roadmapped (pr-research Stage 1), needs ADR |
| 5 | contract presets (+5a classification) | engine built (ADR 017, on stage0); presets/classification unbuilt |
| 6 | background re-evaluation | DESIGN RESERVE, gated on #3 |

## The through-line
Every attempt this investigation made to expand align *outward* (docs consistency, co-change as a
feature, vendored presets, background daemons) was deflated by evidence; every item that *survived* is
either the deterministic architectural slice align already owns or a near-free legibility fix in the
channel agents read. The moat is discipline, not breadth — and the two cheapest wins (#1, #2) attack
the silence problem more directly than any new rule kind.
