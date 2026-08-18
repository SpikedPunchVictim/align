# Probe: `manifestField` component classification (ADR 017 Part B, Falsification §3)

**Gate.** ADR 017 accepted Part B (`manifestField('backstage.role', …)` — classify a component by a
`package.json` field value) but held it **gated** on this test: *"Run user-authored role config
(`manifestField` + hand-written layering) against backstage's 233 role-tagged packages; measure how
much of the real role layering it reproduces… If the manifest-field source's complexity isn't
justified by the result, it stays deferred."*

**Method.** Read-only, against the real backstage checkout at
`/Users/spikedpunchvictim/temp/enterprise-apps/backstage` (233 packages carrying `backstage.role`).
Two questions, each framed as the **placebo test** this project applies to every candidate — measure
the machinery (`manifestField`, the field) against the dumb baseline align **already has** (a path
glob), and against backstage's **actually-enforced** rules:

- **Q1 — classification non-redundancy:** can a path glob (align's existing classifier) reproduce the
  role partition? If yes, `manifestField` is redundant → defer.
- **Q2 — rule value:** does backstage's real role-layering reduce to import-direction rules align
  already expresses, and how faithfully?

Both must be favorable for Part B to promote. This is the same discipline that **cut** co-change
(ADR 019 — fan-in reproduced it) and **cut** the exports-aware deep-import machinery (ADR 020 — a
dumb marker match reproduced it).

---

## Ground truth: 233 packages, 12 roles

| role | n | role | n |
|---|---|---|---|
| backend-plugin-module | 74 | backend-plugin | 20 |
| web-library | 32 | cli-module | 13 |
| node-library | 30 | cli | 6 |
| frontend-plugin | 28 | frontend | 4 |
| common-library | 22 | (3 long-tail roles) | 4 |

Roles are **interleaved** across the two top-level trees: `plugins/` holds 7 distinct roles,
`packages/` holds ~9. Top-level directory does not determine role.

## Q1 — path-glob baseline vs the field: **73.4% ceiling, 27-pt structural gap**

Authored the best-effort ordered glob classifier a diligent user *without* `manifestField` would
write — every observable naming convention (`*-backend-module-*`, `*-backend`, `*-common`, `*-node`,
`*-react`, `cli-module-*`), most-specific-first so align's first-match-wins ordering lets a residual
`plugins/*` catch the un-suffixed `frontend-plugin`. Scored against align's **real** `globMatch`
(`packages/core/src/components/glob.ts`), per-package, vs the `backstage.role` field:

| role | glob recall | why it fails |
|---|---|---|
| backend-plugin-module | **100%** (74/74) | rigid `*-backend-module-*` interior convention |
| backend-plugin | 85% (17/20) | mostly `*-backend` |
| frontend-plugin | 79% (22/28) | residual `plugins/*` catch-all |
| common-library | 59% (13/22) | only 13 carry `-common`; rest `-predicates`/`-model`/bare |
| node-library | 47% (14/30) | only 14 carry `-node`; rest `-utils`/`-api`/`-internal` |
| web-library | **41%** (13/32) | only 13 carry `-react`; rest `-utils`/`-api`/bare |
| frontend-plugin-module | 0% (0/2) | glob-indistinguishable from frontend-plugin |
| **OVERALL** | **171/233 = 73.4%** | — |

`manifestField` = **100% by construction** (it reads the field).

**The 27-point gap is structural, not a "write more patterns" problem:**
1. The three **library** roles (`web`/`node`/`common`-library, 84 packages) have **no reliable
   naming convention** — only 41–59% carry a role-marking suffix; the rest are `-utils`, `-api`,
   `-internal`, or bare. 62 packages are unglobbable on name alone.
2. Roles are **interleaved** under `plugins/` and `packages/`; align's glob dialect has **no
   negation** (rejected at load by `lintGlobPattern`), so an unsuffixed `web-library` and a bare
   `frontend-plugin` both living at `plugins/<name>` cannot be separated by any pattern.
3. Misclassification is **not baseline-fixable**: a mis-bucketed package gets the *wrong*
   component's rules AND pollutes the right component's set — align's baseline suppresses
   *violations*, it cannot repair a *classification*.

**This is the opposite result from the co-change and deep-import probes.** There the dumb baseline
≈ the machinery (2% swings), and the machinery was cut. Here the field beats the best glob by **27
points**, and the gap is a hard limit of path-based classification. On this axis Part B is genuinely
non-redundant.

## Q2 — does the real role-layering reduce to align rules? **Yes, structurally; caveated on exceptions**

backstage enforces roles through two custom ESLint rules; both map onto align's shipped model:

**(a) `no-mixed-plugin-imports.js`** — its `roleRules` array is *literally* a role-to-role
dependency-direction deny matrix:
```
frontend-plugin, web-library            ✗→  backend-plugin, node-library, backend-plugin-module, frontend-plugin
backend-plugin, node-library, backend-plugin-module  ✗→  frontend-plugin, web-library, backend-plugin
common-library                          ✗→  everything (the pure foundation)
```
This is exactly `manifestField(role).cannotDependOn(…other role components)` — align's **already
shipped** `arch.no-dependency`, no new rule kind. Classify by role (Part B), then write the matrix
(existing DSL).

**(b) `no-ui-css-imports-in-non-frontend.js`** — "a package whose role ≠ `frontend` may not import
`@backstage/ui` CSS." That is `manifestField(role≠frontend).cannotDependOn(external('@backstage/ui/*.css'))`
— Part B classification + **Part A external selectors (shipped on main)**.

**Fidelity caps (why reproduction is < 100% even with perfect classification):**
- **Conditional `useSamePluginId` exception** — a cross-role import is *allowed* when source and
  target share `backstage.pluginId` (plugin-override case). **163/233** role-tagged packages declare
  a `pluginId`. align's `arch.no-dependency` is an **unconditional pairwise deny** — it cannot
  express "deny unless same pluginId", so it would **false-positive** on legitimate override imports.
  (True FP count needs the built classifier + a scan; 163 is the upper bound of packages that could
  trigger it, not the realized rate.)
- **Per-target/-package escape hatches** — the root `.eslintrc.js` carries **10
  `excludedTargetPackages`** (with a literal `TODO: Fix these either by right role or by moving
  things to new packages` — i.e. acknowledged debt) and `packages/ui` turns the rule `off`. align
  absorbs these as **baselined debt** (accepted, then silent) — a reasonable fit, not a first-class
  per-pair exclusion.

So align reproduces the **full role-layering structure** (the matrix + the CSS rule) but not the
fine-grained *conditional* exceptions. For align's untooled-market thesis — a repo adopting a role
convention *without* building a bespoke ESLint plugin — the structural match is the payload; the
pluginId exception is an edge backstage itself flags as TODO-debt.

---

## Verdict (revised after adversarial review — see corrections below): **DEFER**

The first draft of this probe concluded "promote-worthy, gated by prevalence." An adversarial Fable
review — its empirical claims **independently re-run and verified** (`scratchpad/matrix_measure.js`,
same-role-cell check) — corrected that to **DEFER**, and the corrections are sound. The honest
verdict is **hold `manifestField` for a second exemplar.**

### Corrections that changed the verdict (all verified)

1. **Q1's "27-pt structural gap" was an overclaim — it's ergonomics, not expressiveness.** The 73.4%
   ceiling is real *for convention globs*, but the baseline was sandbagged: align classifies by path,
   and a path may be a **literal** (`plugins/catalog-backend/**`). Enumerating the `packages/` tree +
   convention rules for `plugins/` + first-match-wins ordering reaches **~100%** with no negation and
   no new machinery — "an explicit path is a pattern, and first-match-wins substitutes for negation."
   So `manifestField` closes a **maintenance/ergonomics** gap (author-owned, colocated, survives
   package moves, no hand-maintained 200-line enumeration that drifts silently), **not** a capability
   gap. That is materially weaker, and it is **not** "the opposite of the cut probes" — it is the same
   shape (the dumb baseline reproduces the output), just with a real toil argument attached, on one
   repo.
2. **Q2 was never measured; measured, it catches ~1 live violation on the exemplar.** Declared-dep
   graph over the 233 (proxy for align's import graph): **1,235 edges → 13 matrix hits → 11 already
   in `excludedTargetPackages` (baseline debt) → 2 live, 1 of which is the eslint fixture
   (`@internal/foo`).** So the role rule, deployed on backstage today, catches **one** real thing. The
   value is entirely **prophylactic / for untooled adopters** — zero demonstrated catches on the
   exemplar. ADR 017 Falsification §3 asked to "measure how much of the real role layering it
   reproduces"; the code-reading argument (Q2 above) was not that measurement.
3. **A real correctness gap `manifestField` cannot fix:** two of the matrix's cells are **same-role**
   (`frontend-plugin ✗→ frontend-plugin`, `backend-plugin ✗→ backend-plugin`). Classifying by field
   value makes all 28 frontend-plugins **one component**, so package-to-package imports inside it are
   intra-component (self) edges `arch.no-dependency` cannot see. align would **silently
   under-enforce** those cells. `manifestField(field, value)` as specced can't express them (you'd
   need group-by-field-value → per-`pluginId` components).
4. **The pluginId FP caveat was overstated.** The `useSamePluginId` carve-out applies **only** to
   `frontend-plugin → frontend-plugin`, not a 163-package cross-role FP surface; realized exempt
   edges in the graph = **0**. The 163 figure was an upper bound, not a rate. (Minor to the verdict,
   but the draft implied a bigger FP risk than exists.)
5. **Ground-truth contamination:** ~**11 of the 233** are test fixtures
   (`packages/eslint-plugin/src/__fixtures__/monorepo/packages/*`, dynamic-feature-service fixtures).
   Real ground truth ≈ 222. This also exposes a **spec hazard the draft never raised**: a naive
   scan-time field read will classify nested fixture `package.json`s into real components unless
   `manifestField` defines manifest ownership (nearest workspace ancestor / exclude non-workspace
   manifests). The fixture `@internal/foo → @internal/bar` shows up as a "live violation" above —
   exactly that garbage.

### The corrected call
- **DEFER.** Q1 proves the mechanism is *nice-to-have where field-roles already exist*; it does not
  prove field-roles are *prevalent* (1/10, backstage only) or that the primitive catches real
  architecture drift (~1 live hit on the exemplar). Promoting on "cheap general primitive +
  thin-but-deep" here is the rationalization promotion-on-evidence exists to stop — and the
  external-selectors parallel is false: Part A **widened an existing rule's target** with multi-repo
  intent evidence; `manifestField` is a **new classification axis** whose entire evidence base is one
  repo that already ships strictly-more-expressive enforcement and would not switch to align's version.
- **What flips it to PROMOTE:** a **second exemplar** — any non-backstage repo with a manifest-field
  classification convention and no bespoke enforcement tooling (found by rerunning the SURVEY sweep on
  a fresh cohort). One is enough, given the genuinely low cost (classification source, no rule kind).
  If promoted then, the build must carry two spec requirements from this review: (a) **nested-manifest
  ownership/exclusion** semantics (the fixture hazard), (b) **same-role cells documented as out of
  scope** in the recipe, honestly.

### What the probe got right (retained)
The 73.4% *conventions-only* arithmetic (Fable's independent re-score: 74.3% on clean data); the
`roleRules` matrix + CSS rule mapping to already-shipped kinds; `excludedTargetPackages`-as-baseline
framing; and the cost-ladder point that this is a classification source, not a rule kind. The build,
if it happens, is cheap — the reason to wait is evidence of **need**, not cost.

## Evidence / reproduction
- Role extraction + glob scorer: run against `…/enterprise-apps/backstage`; raw
  `(dir, name, role)` for all 233 dumped to the probe's working data. Glob scored with align's own
  `globMatch` (`packages/core/dist/components/glob.js`), ordered first-match-wins classifier.
- `packages/eslint-plugin/rules/no-mixed-plugin-imports.js` — the `roleRules` matrix.
- `packages/eslint-plugin/rules/no-ui-css-imports-in-non-frontend.js` — the role→external CSS rule.
- `.eslintrc.js` — the 10 `excludedTargetPackages` + `packages/ui` opt-out.
- `docs/adr/017-2026-07-21-external-selectors-and-presets.md` (on `main`) — Part B spec + Falsification §3.
- Contrast: `docs/adr/proposals/cochange-informed-rule-suggestion/co-change-coupling/PROBE.md`, `docs/adr/proposals/deep-import-provenance/deep-import-provenance-probe/PROBE.md`
  — the two probes where the baseline ≈ the machinery and the machinery was cut.
