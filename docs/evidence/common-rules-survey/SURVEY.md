# Common architecture rules survey — evidence for align's built-in candidates

**Method.** Read the architecture-enforcement config each of the 10 repos already ships (ESLint
boundary rules, custom ESLint plugins, Nx config, package.json manifest signals, circular-dep
scripts, and prose "must not" rules in AGENTS.md/CONTRIBUTING). Ignored pure style/formatting.
Every claim below is repo + file-path cited; quotes are verbatim from the on-disk source at
`/Users/spikedpunchvictim/temp/enterprise-apps/`. Priors from `BEST_PRACTICES.md` and
`pr-research/` are cited, not re-derived, and extended with fresh file-level evidence.

Repos: backstage, cdk8s, directus, langchainjs, n8n, nest, opentelemetry-js, pulumi, strapi, vscode.

---

## 1. Prevalence-ranked table

| # | Rule kind | Repos (count) | Mapping to align | Representative example |
|---|---|---|---|---|
| 1 | **No import cycles** | 5/10 — backstage, vscode, n8n, langchainjs, opentelemetry-js | ALREADY-SHIPPED (`arch.no-cycles`) | backstage `package.json`: `"lint:circular-deps": "madge --circular ."`; vscode `package.json`: `"check-cyclic-dependencies": "node build/lib/checkCyclicDependencies.ts out"`; n8n `eslint-config/src/configs/base.ts:298`: `'import-x/no-cycle': ['error', { ignoreExternal: false, maxDepth: 3 }]`; langchainjs (provider packages) `lint:dpdm": "dpdm --skip-dynamic-imports circular --exit-code circular:1 ..."`; opentelemetry-js `api/package.json`: `"cycle-check": "dpdm --exit-code circular:1 src/index.ts"` |
| 2 | **Layered / role-tagged dependency direction** (path-based or metadata-tagged "X may only depend on Y") | 3/10 hard-lint-enforced (vscode, backstage, n8n); +3 structural-only, no lint enforcement (directus, langchainjs, opentelemetry-js) | ALREADY-SHIPPED (`arch.layer(x).canOnlyDependOn` / `.cannotDependOn`) | vscode `.eslint-plugin-local/code-layering.ts` + `eslint.config.js:102-126` (`common → []`, `node → [common]`, `browser → [common]`, `electron-browser → [common, browser]`, …); backstage `.eslintrc.js` + `packages/eslint-plugin/rules/no-mixed-plugin-imports.js`, driven by `"backstage": {"role": "..."}` tagged on **233 packages** (`grep` count: 74 backend-plugin-module, 32 web-library, 30 node-library, 28 frontend-plugin, 22 common-library, 20 backend-plugin, …); n8n `.ee` license-boundary convention (19 `.ee` dirs) enforced by `no-import-enterprise-edition.ts` |
| 3 | **Deep-import / internal-path provenance ban** (must import a package's public entrypoint, not `/src`, `/dist`, `/internal`) | 3/10 hard-enforced (backstage, n8n, vscode); pr-research spike shows the violations concentrate in *un*tooled repos | ROADMAPPED — Stage 1, gated on `docs/adr/016` public-surface inference | backstage `no-forbidden-package-imports.js` (docs: *"Disallow internal monorepo imports from package subpaths that are not exported"*) + `no-relative-monorepo-imports.js`; n8n `no-internal-package-import.ts` (regex `^(?<packageRoot>@n8n\/[^/]+)\/src\//`, **autofixable** — rewrites to bare package root); vscode `code-no-deep-import-of-internal.ts` |
| 4 | **Public-surface minimization / `export *` ban / `@internal` barrel-escape** | 1/10 hard general lint ban (opentelemetry-js); 2 more with partial/convention enforcement (backstage API-Extractor, vscode prose) | ROADMAPPED — Stage 2, same `docs/adr/016` gate | opentelemetry-js `eslint.base.js:59`: `"no-restricted-syntax": ["error", "ExportAllDeclaration"]` — bans `export *` **everywhere**, no per-file opt-out; backstage `AGENTS.md`/`yarn build:api-reports` (API Extractor); vscode `.github/copilot-instructions.md:84`: *"Do not export types or functions unless you need to share it across multiple components"* (prose only, unenforced) |
| 5 | **Manifest-join / phantom-dependency check** (import graph edge to a package with no matching `package.json` dependency entry) | 4/10 — backstage, cdk8s, strapi, n8n | **NEW PRIMITIVE** (not covered by align's shipped `security.manifest.*` kinds, which police dependency *source*/*novelty*, not import-vs-declaration consistency) | backstage `no-undeclared-imports.js` (docs: *"Forbid imports of external packages that have not been declared in the appropriate dependencies field in package.json"*); cdk8s `.eslintrc.json`: `"import/no-extraneous-dependencies": ["error", {"devDependencies": ["**/test/**", ...], "peerDependencies": true}]`; strapi `eslint-config-custom/back/index.js`: same rule, `error`; n8n `eslint-config/src/configs/frontend.ts:39`: `'import-x/no-extraneous-dependencies': 'warn'` |
| 6 | **Layer/component-scoped external-import boundary** ("this component may not import package/builtin matching P") — the tested hypothesis, see §2 | 1/10 general form (vscode); 3/10 narrower single-symbol variants (backstage, strapi, directus) | **NEW PRIMITIVE**, but concentrated evidence — see verdict below | vscode `eslint.config.js:1476-1553` `local/code-import-patterns`, `hasNode` allow-list explicitly *excludes* `'path'` with inline comment `// 'path', NOT allowed: use src/vs/base/common/path.ts instead`; `hasBrowser` allow-list is `[]` (empty) — no external/builtin import is permitted in browser-layer files beyond the internal `vs/*` restrictions |
| 7 | **Banned import-shape for one specific allowed external package** (must use named subpath / no default import, autofixable) | 2/10 explicit (backstage, strapi); +1 adjacent (vscode MUI-style pattern not present but analogous rule family) | Thin — a narrower cousin of #6, not the same shape | backstage `no-top-level-material-ui-4-imports.js` (auto-fixes `import {Box} from '@material-ui/core'` → `import Box from '@material-ui/core/Box'`); backstage `packages/core-components/.eslintrc.js`: `restrictedImports: [{name: '@material-ui/core', message: "Please import '@material-ui/core/...' instead."}]`; strapi `eslint-config-custom/front/index.js`: `no-restricted-imports` on `lodash` — *"Please use import [method] from lodash/\[method\]"* |
| 8 | **DI-container / decorator-shape structural rules** (constructor-injection discipline tied to a decorator, not the import graph) | 1/10 (n8n) | Out of align's import-graph remit; expressible today only via the `custom.host` escape hatch, not a promotable built-in | n8n `no-constructor-in-backend-module.ts` (a class decorated `@BackendModule` must have no constructor — autofix removes it); `no-type-only-import-in-di.ts` (constructor params in `@Service()` classes can't use `import type`, autofix strips the `type` keyword) |
| 9 | **Max lines per file** | 0/10 | ALREADY-SHIPPED (`arch.metric`, metric: `loc`) — but **zero measured prevalence** in this sample; no repo enforces it via lint | — (checked all 10 `.eslintrc*`/`eslint.config.*` for `max-lines`; no hits) |
| 10 | **`package.json` subpath privacy (`"imports"` field)** | 0/10 | Would map to a NEW PRIMITIVE if it existed, but doesn't in this sample | `grep '"imports"'` across all 10 repos' `package.json` files: 0 hits |
| 11 | **`browser`/platform substitution field** (npm bundler-level module substitution, adjacent to but distinct from a lint-enforced ban) | 2/10 with real substitution maps (vscode 22 files, opentelemetry-js 12 files); `@directus/utils` uses `node`/`browser`/`shared` subpath *exports* instead (1/10) | Adjacent signal, not itself a rule kind — informs component classification for #6 | `@directus/utils/package.json`: `"exports": {".": "./dist/shared/index.js", "./node": "./dist/node/index.js", "./browser": "./dist/browser/index.js"}`, `browser/tsconfig.json`: `"lib": ["ES2023","DOM"], "types": []` (strips ambient Node globals — compile-time hygiene, not a lint-time import ban) |

---

## 2. The `cannotImport(externalPattern)` hypothesis — measured verdict

**Hypothesis under test:** *"component/layer X may not import a given external package or Node
builtin matching pattern P"* (the browser-safe-core / "domain can't import the ORM" shape) —
does this justify a new first-class `cannotImport(externalPattern)` primitive?

**Measured answer: weaker than expected as a standalone, general-purpose primitive. Real in 1/10
repos at full generality; present as a narrower cousin in 3 more.**

- **vscode is the one clean, rigorous, general-purpose hit.** `local/code-import-patterns`
  (`.eslint-plugin-local/code-import-patterns.ts` + 47 `target` entries in `eslint.config.js`) is a
  **default-deny allowlist**: every file must match one of its layer's `restrictions` patterns or the
  import is rejected (`badImport`), and the `hasNode`/`hasBrowser`/`hasElectron` allow-lists gate
  *which* external packages and Node builtins each runtime layer may use at all. Two concrete
  `cannotImport`-shaped facts fall out of it: (a) the `browser` layer's `hasBrowser` allow-list is
  `[]` — no external package or Node builtin is importable there outside the internal `vs/*`
  restriction set; (b) even in the `node` layer, the builtin `'path'` is explicitly *excluded* from
  the `hasNode` allow-list with the comment `// 'path', NOT allowed: use src/vs/base/common/path.ts
  instead` — a builtin banned repo-wide in favor of an internal wrapper, enforced identically to a
  layering rule. This is real and load-bearing (the config carries an explicit `!!! Do not relax
  these rules !!!` comment and has been in force for years across thousands of files) — but it is
  **one repo**, and the rule is fused with vscode's general layering system, not a standalone concern.
- **n8n has the inverse shape**, not the hypothesized one: `misplaced-n8n-typeorm-import.ts` says
  *only* `@n8n/db` may import `@n8n/typeorm` — "one component owns this external package," rather
  than "this component may not touch that package." Useful, but a different DSL verb
  (`canOnlyBeImportedBy`-on-an-external, not `cannotImport`).
  Also n8n's pattern is 1-of-1: no other repo has this "single owner of an external dependency" rule.
- **backstage and strapi have only symbol-level import-style bans**, not component-vs-package
  boundary rules: backstage bans a *bare* `@material-ui/core` import (must use the subpath) and bans
  self-importing `@backstage/core-components`; strapi bans a bare `lodash` import in front-end code.
  These are bundle-size/perf hygiene rules with an autofix, not "component X may never depend on
  package Y" — the package is allowed, only the import *shape* is restricted.
- **directus's node/browser/shared package split is structural, not lint-enforced.** The
  `browser/tsconfig.json` strips ambient Node globals (`"types": []`) but does not stop
  `import fs from 'fs'` at the module level — TypeScript's explicit-import resolution still works
  even with `types: []`; only ambient globals like `process`/`Buffer` are lost. This is a real
  intent, weakly enforced.
- **cdk8s, nest, pulumi (Go depguard aside), opentelemetry-js, langchainjs**: no rule of this shape
  found. (Pulumi's Go-side `.golangci.yml` *does* have a real `depguard` ban —
  `deny: pkg: github.com/golang/protobuf, desc: Use google.golang.org/protobuf instead` — a clean
  cross-ecosystem confirmation that the *pattern* is real practice, but it's Go, out of align's
  TS/JS remit, and repo-wide rather than component-scoped.)

**Verdict for align:** the evidence does not support a dedicated, standalone `cannotImport`
rule *kind* on current prevalence (1/10 general, 3/10 narrow-and-different-shaped). It does support
adding `cannotImport(pattern)` as a **modifier on the existing layer/component verbs** — i.e.
`arch.layer(x).cannotDependOn(y)` already handles internal components; extending the same verb's
target type to accept an external-package/builtin selector (not just another align component) would
capture vscode's exact pattern with no new rule kind, only a widened selector grammar. Ship it as a
DSL extension to `arch.no-dependency`, not a new IR rule kind — the evidence is real but doesn't
clear the bar for its own top-level primitive.

---

## 3. Promotion shortlist

Ranked most → least evidence-worthy, restricted to candidates that (a) clear a real prevalence bar
and (b) are not already shipped or roadmapped.

### 1. Manifest-join / phantom-dependency check — STRONGEST candidate
**Evidence:** 4/10 (backstage, cdk8s, strapi, n8n) — see table row 5. This is also the one item
`pr-research/TOP-5-CATEGORY-BREAKDOWN.md` (§5) explicitly flags as "worth doing" because it **reuses
align's existing import-graph edges** — no new scan, just a join against each `package.json`'s
`dependencies`/`devDependencies`/`peerDependencies`. Not covered by align's shipped
`security.manifest.source-hygiene` (dependency *source*, e.g. git vs registry) or
`security.manifest.new-dependency` (novelty since baseline) — those are both repo-wide manifest
checks; this one is import-graph-vs-manifest consistency, per-component.

**Implied DSL shape:**
```ts
security.manifest.declaredDependencies(component?)
// or, if component-scoped like other arch rules:
arch.component(x).importsMustBeDeclared()
```
Flags any import edge from a file classified into `x` to an external package with no matching entry
in the owning `package.json`'s dependency fields (test-classified files may satisfy via
`devDependencies`). Difficulty: low — reuses the existing scanner edges plus a `package.json` read
already needed for `security.manifest.*`.

### 2. Layer-scoped external/builtin import boundary (`cannotDependOn` widened to external selectors)
**Evidence:** concentrated but rigorous — 1/10 at full generality (vscode), narrower variants in 3
more (see §2 verdict). Labeling this honestly as **thin-but-deep**: a single repo, but the single
richest, longest-lived, most carefully maintained example in the entire survey (47 target rules, an
explicit "do not relax" comment, enforced since the ESM migration). Promote as a DSL widening, not a
new rule kind — see §2 for the exact shape recommendation.

**Implied DSL shape:**
```ts
arch.layer(browserLayer).cannotDependOn(external('node:*'), external('fs'), external('path'))
```
Reuses `arch.no-dependency`'s existing kind; the only new surface is letting the target of
`cannotDependOn` be an external-package/builtin selector instead of only another align component.

### 3. Banned-import-shape for an otherwise-allowed external package — labeled THIN
**Evidence:** 2/10 explicit (backstage MUI v4, strapi lodash), both autofixable, both bundle-size /
consistency hygiene rather than architecture-direction. Real and recurring, but the sample is small
and the motivation (bundle size) is arguably not "architecture conformance" in align's sense at all —
closer to a lint rule than a graph rule. Not promoted to the primary shortlist; noted for
completeness. If align ever grows a general "banned import specifier + required subpath rewrite"
verb, this is its evidence base — but it's thin, and it says so.

**Not promoted (explicitly ruled out as new primitives), with reasons:**
- *Role/tag-driven layering* (backstage `backstage.role`) is not a new primitive — it's an
  already-expressible `arch.layers` rule that only needs a component-classification preset keyed off
  a `package.json` field, matching `pr-research`'s Category 4 conclusion ("ship presets, not
  features").
- *License/edition (`.ee`) boundary* (n8n, strapi) is likewise not new — it's `arch.layer(nonEE)
  .cannotDependOn(ee)` once files are classified by the `.ee` directory-suffix convention. A preset,
  not a primitive.
- *DI-decorator-shape rules* (n8n `no-constructor-in-backend-module`, `no-type-only-import-in-di`)
  are AST-shape rules keyed to a decorator, not import-graph rules — outside align's remit; the
  existing `custom.host` escape hatch is the correct fit if a team wants this, not a built-in.

---

## 4. Honest caveats

- **Sample skew.** All 10 repos are elite OSS with mature CI/lint infrastructure — per
  `pr-research/README.md`, "the population that needs align least." Every prevalence number above is
  a floor for the untooled-repo population align actually targets, not a ceiling; several `pr-research`
  findings (e.g. deep-import violations concentrating in n8n/vscode's *less-tooled* corners) suggest
  real-world prevalence for several of these rule kinds is higher outside this sample, not lower.
- **ESLint-config presence bias.** A repo scored "0" for a rule kind sometimes means "doesn't need
  it" and sometimes means "doesn't have the infrastructure to express it" — nest's `eslint.config.mjs`
  has essentially zero architecture rules (pure type-safety toggles) despite being an
  architecture-famous DI framework; its boundaries are enforced by the *framework's* module/DI system,
  not by lint. That's a real architectural discipline this survey's method is structurally blind to.
- **Nx module-boundaries prior did not pan out.** The task brief's recon flagged opentelemetry-js and
  strapi for `@nx/enforce-module-boundaries` / `depConstraints`. Neither repo's `nx.json` (nor any
  `project.json` under either tree) contains `enforce-module-boundaries` or `depConstraints` —
  grepped directly, zero hits in both. Both repos use Nx purely for task caching/build orchestration.
  This prior should be retired, not re-cited.
- **`@langchain/eslint`'s rule source is not inspectable.** langchainjs's per-provider
  `eslint.config.ts` files (`libs/providers/*/eslint.config.ts`) all delegate to a published
  `@langchain/eslint` package not vendored in this on-disk checkout — its actual rule contents
  (beyond the `dpdm` circular-dep wiring, which is directly visible in each package's `package.json`
  scripts) could not be read. Anything langchainjs might additionally enforce through that package is
  an unknown, not a measured zero.
- **`arch.metric` (max-lines-per-file) has zero measured prevalence in this sample** — worth flagging
  since it's already a shipped align rule kind. None of the 10 repos enforce a file-length limit via
  lint. This doesn't mean the rule is wrong, only that this survey provides no supporting evidence for
  it; its justification rests on other grounds.
- **Prose-only "must not" rules were mostly redundant with `BEST_PRACTICES.md`.** AGENTS.md/
  copilot-instructions.md/CONTRIBUTING.md scans (backstage, n8n, strapi, vscode) surfaced one item not
  already in the priors worth flagging as *not* align-expressible: vscode's
  `.github/copilot-instructions.md:145` — *"You MUST NOT use storage keys of another component only to
  make changes to that component"* — a cross-component coupling rule enforced through shared state
  (storage keys), not an import edge, so invisible to any import-graph tool including align.

---

## 5. Round-2 corrections (Fable review, independently verified)

A skeptical review audited §1–§4 and spot-checked claims on disk. Three corrections; the first two
change the shortlist ranking, the third reframes the "rejections" as a second deliverable shape.

### 5.1 Manifest-join is **3/10, not 4/10** — n8n does not count
The n8n citation (`n8n/packages/@n8n/eslint-config/src/configs/frontend.ts:39`,
`import-x/no-extraneous-dependencies: 'warn'`) sits inside a `files: ['**/*.test.ts',
'**/test/**/*.ts', '**/__tests__/**/*.ts', '**/*.stories.ts']` override — **test/stories files only,
`warn` severity, frontend config only**. Verified on disk. That is not phantom-dep enforcement on
product code. Real count: **backstage, cdk8s, strapi = 3/10** (all at `error`). Manifest-join also
remains adjunct, not flagship: `pr-research/TOP-5-CATEGORY-BREAKDOWN.md` rates the category
**LOW-MEDIUM confidence**, says "fold the useful half (phantom-dep) into Stage-1 provenance," and
notes depcheck/knip already own it. Keep it — but as a **Stage-1-provenance adjunct**, not the lead.

### 5.2 The external-boundary rule is **#1, not #2** — the lint lens undercounts it
§2's "1/10, weaker than expected" is a **measurement artifact of the enforcement-config lens**, not a
finding about the world. The same intent lives in non-lint channels this survey didn't count:
- **vscode enforces it through four independent mechanisms**, not one: `code-import-patterns`
  (`eslint.config.js` layer allow-lists), the electron-utility layer ban (`:1437`), the repo-wide
  `dompurify` ban in favor of the internal `domSanitize` wrapper (`:1465`), and the copilot
  extension's wholesale `builtinModules` + named-dependency ban (`:2438`). One repo, four "do not
  relax"-grade mechanisms — intensity evidence §2 left on the table.
- **Demand expressed structurally, not as lint:** 23 vscode + 18 otel `browser` substitution maps,
  directus's `./node` vs `./browser` exports split (`@directus/utils`), and `BEST_PRACTICES.md §8.3`
  ("core/domain must not import framework/platform types") stated verbatim with three repo exemplars,
  including langchain-core's "no provider SDKs" enforced purely by package partitioning — invisible to
  any lint census.

Verdict: this is the **one intent multiple repos demonstrably want, served by no existing tool for
align's untooled target market**, and it needs no new rule kind — only widening `cannotDependOn`/
`canOnlyDependOn`'s target to accept an external-package/builtin selector (survey §2's own shape). It
is the **highest-leverage built-in on this evidence.** Promote to #1.

### 5.3 Roles / `.ee` are the strongest **preset** candidates, not rejections
§3 correctly ruled roles and `.ee` out as new *rule kinds* (they're expressible via existing
`arch.layers`/`cannotDependOn`) but then dropped them. They should be re-filed as the lead **preset**
candidates — a preset being a canned *(component classification + rules)* bundle that composes
existing primitives, introducing no new rule kind (`pr-research` Category 4's "ship presets, not
features"):
- **`enterpriseEdition({ glob })`** — n8n's 98 `*.ee.ts` files: classify by glob (shippable today),
  emit `community.cannotDependOn(enterprise)`.
- **`backstageRoles()`** — backstage's **233** packages classified by `package.json` `backstage.role`
  (`web-library`/`node-library`/`backend-plugin`/…): read the field, build role components, apply the
  standard role layering. Needs one small enabling capability — **classify a component by a manifest
  field** (align globs on paths today) — still not a rule kind.
- The widened selector (5.2) should be designed so the **inverse** `external(x).canOnlyBeImportedBy(y)`
  falls out for free — captures n8n's `misplaced-n8n-typeorm-import` ("`@n8n/typeorm` importable only
  from `@n8n/db`").

### Revised shortlist
1. **External/builtin import boundary** — widened `cannotDependOn` selector. Rule. Highest leverage.
2. **Preset layer** — `enterpriseEdition()` (today) + `backstageRoles()` (needs manifest-field
   classifier). Ships the role/`.ee` conventions without new rule kinds.
3. **Manifest-join / phantom-dep** — 3/10, build as a Stage-1-provenance adjunct, not a flagship.
4. Banned-import-shape — THIN, not promoted (unchanged).

The two shapes — a **rule** (#1) and a **preset layer** (#2) — are the subject of ADR 017.
