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

## Verdict

**Q1 favorable (strong), Q2 favorable (structural, caveated). The probe supports promoting Part B —
but as a weaker, honest "yes" than the detection fixes, and squarely gated by prevalence.**

- **For:** the field is genuinely non-redundant with path globs (73% structural ceiling — unlike the
  cut probes); the real enforcement reduces cleanly to **already-shipped** rule kinds
  (`cannotDependOn`, `external()`), so Part B is a **classification source, not a new rule kind** —
  the cheap end of the cost ladder (a scan-time package.json read, IR-portable, inheriting the
  untrusted story for free per ADR 017).
- **Against / honest weaknesses:**
  1. **Prevalence is thin — 1/10** (backstage only, per SURVEY §5). This is the load-bearing
     weakness. ADR 017 already faced it: it **cut** vendored `backstageRoles()` and kept only the
     *general* "classify by any manifest field" primitive. Justification therefore rests on
     "thin-but-deep" (one rich exemplar) + the primitive's generality/cheapness — the same bar
     external selectors cleared (1/10 vscode, "thin-but-deep", shipped).
  2. **Fidelity < 100%** — the conditional pluginId exception is an unexpressible FP source; per-pair
     exclusions become baseline debt.
  3. No **second exemplar** yet demonstrates a non-backstage repo needing field-based classification.

**Recommended framing (for Fable review):** two defensible calls —
- **(A) Promote now:** build `manifestField` as the general classification source. Cost is low (no
  rule kind), the classification value is measured and real, and it unlocks the one survey
  convention path globs provably can't reach. Ship the backstage role matrix as a **recipe** (ADR
  017's decided vehicle), not vendored policy.
- **(B) Hold for a second exemplar:** the ADR's own reserve-condition instinct ("wants plural"). Q1
  proves the mechanism is *needed where field-roles exist*; it does not prove field-roles are
  *prevalent*. Defer until a second repo demonstrates the need, keeping the bar identical to every
  other promotion.

The probe cleanly separates the two axes the decision turns on: **classification** (machinery beats
baseline — promote-worthy) vs **prevalence** (1/10 — the reason to hesitate). That is the call for
the owner + Fable, not the data.

## Evidence / reproduction
- Role extraction + glob scorer: run against `…/enterprise-apps/backstage`; raw
  `(dir, name, role)` for all 233 dumped to the probe's working data. Glob scored with align's own
  `globMatch` (`packages/core/dist/components/glob.js`), ordered first-match-wins classifier.
- `packages/eslint-plugin/rules/no-mixed-plugin-imports.js` — the `roleRules` matrix.
- `packages/eslint-plugin/rules/no-ui-css-imports-in-non-frontend.js` — the role→external CSS rule.
- `.eslintrc.js` — the 10 `excludedTargetPackages` + `packages/ui` opt-out.
- `docs/adr/017-external-selectors-and-presets.md` (on `main`) — Part B spec + Falsification §3.
- Contrast: `docs/evidence/co-change-coupling/PROBE.md`, `docs/evidence/deep-import-provenance-probe/PROBE.md`
  — the two probes where the baseline ≈ the machinery and the machinery was cut.
