# ADR 017: External-import selectors + manifest-field classification

**STATUS: DRAFT — pending owner sign-off.** Nothing here is built. It proposes two additive mechanisms
and a falsification plan; per promotion-on-evidence doctrine (`docs/proposals/rule-expansion-evaluation.md`)
each is gated on the Falsification section, not authorized by accepting this ADR.

> **Revision (2026-07-21, post-Fable-review).** An earlier draft proposed a `presets` layer shipping
> `enterpriseEdition()` and `backstageRoles()`. **Cut.** A vendored `backstageRoles()` ships align a copy
> of *Backstage's* architectural policy (field name, role vocabulary, and which roles may depend on which),
> at 1/10 convention prevalence, contradicting the same §8.3 core-purity principle Part A is built on. The
> general, vendor-agnostic capability is **classify a component by a manifest field** (Part B below); with
> it, the Backstage case is a few lines of *user-authored* config (align never encodes "backstage"), and
> the `.ee` case needs nothing new. The earlier draft also mis-stated the IR impact of Part A — corrected
> below (both `arch.no-dependency` **and** `arch.layers` widen, opt-in).

## Context

`custom.host` is align's escape hatch for invariants the built-in kinds can't express. Using it for
*common* asks produces confusing, non-portable config: the README's "keep a package browser-safe" recipe
is ~40 lines of hand-rolled graph BFS that — being host code — is **not portable to untrusted mode**
(ADR 014), not in the IR (ADR 002), and outside the cache/explain story (ADR 005/007).

`docs/evidence/common-rules-survey/SURVEY.md` (§2, §5) mined 10 enterprise repos and, after a skeptical
review, resolved the highest-value built-ins into **one rule and one classification primitive** — not a
"library of rules" and not vendored presets:

1. **A rule (Part A):** a component/layer *may not import a given external package or Node builtin*.
   vscode enforces this through four independent mechanisms; the intent also appears as 23 vscode + 18 otel
   `browser` substitution maps, directus's `./node` vs `./browser` exports split, and `BEST_PRACTICES.md
   §8.3` ("core must not import framework/platform types"). Un-owned for align's untooled target market;
   needs **no new rule kind** — only widening the dependency-direction rules to accept an external target.
2. **A classification primitive (Part B):** the one capability genuinely missing under the survey's
   role/`.ee` conventions is *classify a component by a manifest field* (align classifies by path glob
   only today). That single primitive makes both conventions user-authored config — align ships mechanism,
   the user owns the policy.

Manifest-join / phantom-dep (SURVEY §5.1, 3/10, contested by depcheck/knip) is **out of scope** — it folds
into the Stage-1 deep-import provenance ADR as an adjunct.

## Decision

### Part A — external selectors on the dependency-direction rules

Today `cannotDependOn(...refs)` compiles to **`arch.no-dependency`** (pairwise `{from,to}` deny) and
`canOnlyDependOn(...refs)` compiles to **`arch.layers`** (a `{layer, canDependOn:[...]}` allow-list)
(`packages/core/src/dsl/factories.ts:179-203`). Externals are excluded from every `arch.*` evaluator by
construction — the evaluators read only `graph.nodes`/`graph.edges`, never `externalNodes`/`externalEdges`
(`types/graph.ts:94-98`). This ADR introduces an **external selector** as a permitted *target*:

```ts
external(pattern: string, opts?: { includeTypeOnly?: boolean }): ExternalSelectorToken;

c.webShared.cannotDependOn(external('node:*'));                       // no Node builtins (runtime)
c.core.cannotDependOn(external('react', { includeTypeOnly: true }),  // §8.3: core free of framework,
                      external('express', { includeTypeOnly: true }));//        types included
c.webShared.canOnlyDependOn(c.utils, external('lodash'));            // allow-list incl. one external
```

**Both rule kinds widen, and the widening is opt-in (this is the corrected IR impact):**
- `arch.no-dependency`: `to` becomes `ComponentRef | ExternalSelector`. Evaluator gains an external-edge
  match arm (over `graph.externalEdges`) alongside the existing internal arm.
- `arch.layers`: a layer's `canDependOn` list may include external selectors. **Back-compat is the hazard
  and the constraint:** externals are invisible to `arch.layers` today, so an existing components-only
  allow-list must keep ignoring external edges entirely (the same-count regression test must still pass).
  Rule: external edges are evaluated by an `arch.layers` rule **only if that rule names at least one
  external selector**; a rule with none behaves exactly as today. So "allow-list of components + at least
  one external" is opt-in, and the default-deny form vscode uses (`canOnlyDependOn(external(...))` with an
  empty/narrow external allow-list) becomes expressible without touching any existing rule's meaning.
- **No new rule kind.** Two existing kinds gain a target variant. First-class ⇒ cached (ADR 005),
  explainable + Mermaid (ADR 007), and **portable to untrusted mode** (ADR 014): an `ExternalSelector` is a
  pattern string in the IR, evaluated by matching `graph.externalEdges`, no repo code executed — so it
  survives `align export-ir` → `--untrusted`, where `custom.host` is refused. (Verified against ADR 014's
  `assertNoCustomHostRules`.)

**The inverse — decided, not hand-waved.** `external(x).canOnlyBeImportedBy(...components)` ("only
`@n8n/db` may import `@n8n/typeorm`") is **a targeted allow-list keyed on the external target**, not the
pairwise `arch.no-dependency` read backwards (pairwise expansion can't cover files classified into *no*
component). It compiles to a small allow-list variant sharing the external-match machinery: flag any
external edge to a matching node whose `from` file is not in the allowed set. Reusing `arch.layers`'
allow-list shape with an external *source* is the likely home; the exact IR slot is an implementation
decision the build resolves, but it **is** a distinct evaluator arm, and this ADR says so.

**Semantics that must be pinned (in `docs/ir-schema.md`) so every IR consumer matches identically:**
- Pattern dialect: glob over the normalized external id — `external('node:*')`, `external('fs')`,
  `external('node:fs')` all match the builtin (normalization already exists, `types/graph.ts:59-65`);
  `external('@scope/*')`, `external('lodash')` match by package name.
- `includeTypeOnly` **default `false`** (match runtime edges only) — the browser-safety case; core-purity
  (§8.3, "must not import framework *types*") opts in. Mirrors `arch.no-cycles`' existing `includeTypeOnly`.
- **Ungrounded-selector visibility:** an external selector skips ADR 008 reference-validity (a ban on an
  absent package is *correctly* vacuously green), BUT a selector that matches **no** external node in the
  graph is surfaced as an advisory (the `ungroundedComponents` precedent, ADR 008's 2026-07-13 amendment),
  so a typo (`external('lodsh')`) is not permanently, invisibly green.
- Rule-id scheme accommodating glob characters in the external target.

### Part B — manifest-field component classification (the one general primitive)

align classifies components by path glob only (`components: { web: 'packages/web/**' }`, ADR 002). Add a
second, vendor-agnostic classification source: **by a `package.json` field value.**

```ts
components: {
  backendPlugins:  manifestField('backstage.role', 'backend-plugin'),   // user names the field + value
  frontendPlugins: manifestField('backstage.role', 'frontend-plugin'),
  enterprise:      'packages/**/*.ee.ts',                               // glob (works today, unchanged)
}
```

- **Evaluated at scan time, not config-load time.** The scanner already reads each `package.json` as text
  (ADR 013/014's "reading data" category); classifying a package's files by a field value is IR-portable
  data, so it inherits the untrusted story for free. (This is the fix for the earlier draft's "pure
  function reads package.json" contradiction — a config-load-time read would bake a stale repo snapshot
  into `export-ir`.)
- **Vendor-agnostic.** align knows *how to read a field*; it knows nothing about `backstage.role`'s
  vocabulary or layering policy. The user writes both.
- **Recipes, not presets.** A new `docs/recipes/` page shows the three cases end-to-end, all in
  user-authored config: browser-safe (`cannotDependOn(external('node:*'))`), `.ee` license boundary
  (glob + `cannotDependOn`), and role-based layering (`manifestField` + the user's own `cannotDependOn`/
  `canOnlyDependOn` — align never encodes a vendor's policy). No `presets` field, no shipped bundles.

**The cut rule (where the line is):** align owns anything expressible as *vendor-agnostic declarative data
parameterized by the user* — selectors, classification sources, rule kinds, all IR-serializable. Anything
whose correctness requires align to track a specific third party's conventions or releases (field names,
role vocabularies, layering policy) is user config or a recipe — at most a separately-versioned community
package outside core, which align need not bless in v1.

## Falsification / validation plan

1. **External selector (Part A).** Author the browser-safe rule and migrate align's own `node:child_process`
   confinement (currently a `custom.host` predicate in `align.config.ts`) to `external()` rules; confirm
   they express the intent with no host code, and **evaluate correctly under `align check --untrusted`**
   (IR-only) — which `custom.host` cannot. Reproduce vscode's `browser`-layer default-deny allow-list via
   `canOnlyDependOn(external(...))`; if the allow-list form can't capture it, that's a scope finding, not a
   silent gap. Confirm the `arch.layers` back-compat invariant: an existing components-only allow-list's
   result is byte-identical (the same-count regression test still passes).
2. **`includeTypeOnly` default.** Confirm `external('node:*')` ignores `import type` edges and
   `external('react', { includeTypeOnly: true })` catches a type-only framework import — the two flagship
   uses want opposite defaults.
3. **Manifest-field classification (Part B).** Run *user-authored* role config (`manifestField` +
   hand-written layering) against backstage's 233 role-tagged packages; measure how much of the real role
   layering it reproduces and hand-check a sample. This is the same experiment the cut `backstageRoles()`
   would have run — minus align shipping the vendor policy. If the manifest-field source's complexity isn't
   justified by the result, it stays deferred while the external selector (Part A) still ships.

## Out of scope

- **Vendored presets** (`backstageRoles`, `enterpriseEdition`, a `presets` field) — cut; Part B's general
  primitive + recipes replaces them.
- **Manifest-join / phantom-dependency** — folds into the Stage-1 provenance ADR; 3/10; contested.
- **Banned-import-shape / required-subpath-rewrite** (MUI-v4, lodash) — THIN, 2/10, bundle-size not
  architecture (SURVEY §3).
- **DI-decorator / AST-shape rules** — not import-graph rules; `custom.host` remains the fit.
- **Cross-component coupling via shared state** (vscode storage-key rule) — not an import edge.

## Alternatives considered

- **A blessed `custom.host` predicate library / vendored presets.** Rejected: non-portable to untrusted
  mode, not in the IR, no explain payload; and a vendored preset makes align maintain a third party's
  policy (the primary reason `backstageRoles()` was cut). First-class selectors + a general classifier are
  the vendor-agnostic form.
- **A new dedicated rule kind for external imports.** Rejected: widening the two existing dependency
  kinds is cheaper (target variants + evaluator arms) and keeps one mental model — `cannotDependOn`/
  `canOnlyDependOn` target *things*, some external.
- **A separate `cannotImport` verb.** Rejected on evidence: the demand's shape is "a target of the
  dependency-direction rule," so a new verb fragments the DSL for no added expressiveness.
- **A `presets` mechanism for `enterpriseEdition` alone.** Rejected: `.ee` is ~4 lines of existing config
  by hand; a merge algorithm + collision semantics + new `defineProject` surface is mechanism for a
  4-line payload. A recipe covers it.

## Consequences

- `arch.no-dependency` and `arch.layers` IR target types widen (additive, opt-in); a new `external()` DSL
  selector with an `includeTypeOnly` option; the two evaluators gain external-edge arms; a distinct
  allow-list arm for the `canOnlyBeImportedBy` inverse. Existing rules and IR unaffected by construction.
- A new `manifestField(...)` component-classification source, evaluated at scan time (IR-portable).
- A new `docs/recipes/` page; the confusing browser-safe README recipe collapses to
  `c.webShared.cannotDependOn(external('node:*'))` (portable to untrusted mode) and should be replaced.
- align's own `node:child_process` `custom.host` predicate migrates to an `external()` rule — a dogfood
  proof of Part A, and one fewer non-portable rule in align's own config.
- `docs/ir-schema.md` gains the external-selector pattern/`includeTypeOnly`/normalization spec.

## Evidence

- `docs/evidence/common-rules-survey/SURVEY.md` §2, §5.2, §5.3 — prevalence + corrected ranking.
- `packages/core/src/dsl/factories.ts:179-203` — `cannotDependOn`→`arch.no-dependency`,
  `canOnlyDependOn`→`arch.layers` (the corrected IR-impact basis).
- `packages/core/src/types/graph.ts:59-65,94-98` — external-id normalization; externals excluded from
  `arch.*` by construction (the back-compat constraint).
- `BEST_PRACTICES.md` §8.3 — core-purity intent, verbatim, three exemplars.
- vscode `eslint.config.js` (`code-import-patterns` + `:1437`, `:1465`, `:2438`); backstage
  `package.json backstage.role` (233 pkgs); n8n `*.ee.ts` (98 files) — the concrete conventions.
