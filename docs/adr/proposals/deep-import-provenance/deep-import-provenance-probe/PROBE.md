# Deep-import provenance probe — Arm A (dumb marker match) vs Arm B (exports-aware)

**Question this probe answers:** reconciled-build-order.md item #4 requires a placebo test *before*
crediting the `exports`-parsing machinery — "compare the exports-aware machinery against a dumb
`/src/|/dist/` cross-package grep before crediting the machinery." This is that test, run for real
(not estimated) on n8n and vscode, the two repos the earlier research flagged.

Script: `deep_import_probe.py` — throwaway, kept outside this repo in the session scratchpad per
instruction, not committed here. (Not linked: it lives outside the repo tree.)

## The two arms, exactly as specified

- **Arm A (dumb):** flag any cross-package import whose specifier subpath contains a path segment
  `src`, `dist`, `lib`, or `internal`. Pure string match. No `package.json` is ever opened.
- **Arm B (exports-aware):** same base detection, but a hit is **suppressed** if the target
  package's `package.json` `exports` map declares that subpath as public — exact key or a wildcard
  pattern (`"./*"`, `"./foo/*"`), matched the way Node actually resolves subpath patterns.

## Result 1 — n8n (a real pnpm workspace: `pnpm-workspace.yaml` → `packages/*`,
`packages/@n8n/*`, `packages/frontend/**`, `packages/extensions/**`, `packages/testing/**`)

66 workspace member packages discovered from the declared globs (not "any `package.json` in the
tree" — see the methodology note below on why that distinction matters).

| | count |
|---|--:|
| Arm A raw hits | **42** |
| Arm B suppresses (declared public subpath, wildcard-aware) | **1** (2.4%) |
| Arm B still flags | **41** |

The one suppression: `n8n-workflow/src/expression-sandboxing`, imported from a performance benchmark
file. `n8n-workflow`'s `package.json` declares `"./*": "./*"` in its `exports` map — a blanket
self-mapping wildcard that opts the whole package **out of** exports encapsulation entirely (a common
"don't break existing deep-import consumers" escape hatch). Node's own resolution treats this as a
legitimately declared subpath, so Arm B is technically correct to suppress it — but it's a debatable
win: the package didn't curate a public surface, it disabled the enforcement mechanism. Every other
n8n package hit (41/42) has **no `exports` field at all** (`n8n-core`, `n8n-nodes-base`,
`@n8n/design-system`, `@n8n/api-types` all main-only) — Arm B has nothing to consult for any of them,
so it cannot change the verdict no matter how good the wildcard matching is.

**Hand-checked sample (4 of 42, chosen for diversity across target packages), all confirmed TP by
direct file inspection:**
- `@n8n/design-system/src/components/N8nIcon/icons` (from `editor-ui/.../parameters.ts`) — the
  `IconName` type is genuinely not re-exported anywhere in the package's own `src/index.ts` barrel.
- `@n8n/api-types/dist/schemas/user.schema` for `Role` (from `rest-api-client/.../dynamic-banners.ts`)
  — **the same file's line 1 already imports from the correct barrel (`@n8n/api-types`), and that
  barrel *does* re-export `Role`** (`index.ts:195-203`). Line 2 reaches into `dist/schemas/user.schema`
  for the identical symbol anyway. This is not a case where the public surface is missing the symbol —
  it's a straightforwardly avoidable violation sitting one line below its own fix.
- `@n8n/ai-workflow-builder/dist/workflow-builder-agent` for `ChatPayload` (from
  `cli/.../ai-workflow-builder.service.ts`) — same file's lines 1-2 correctly import
  `AiWorkflowBuilderService`/`ResourceLocatorCallbackFactory` from the package's real entrypoint; line
  3 reaches past it. The package *does* have an `exports` map (`"."` only, no subpath) — Arm B
  correctly still flags this one (resolvable, undeclared).
- The dominant cluster (30+ of the 42 hits): `@n8n/nodes-langchain/**` reaching into
  `n8n-nodes-base/dist/nodes/<Node>/**/helpers|interfaces|manual.mode` — nodes-base has no `exports`
  field and only `main: index.js`; nodes-langchain structurally depends on the internal per-node file
  layout of a sibling package. Real, repeated, actionable — exactly the "invisible to tsc, invisible to
  most ESLint configs" class the feature targets.

No false positives surfaced in the hand-checked sample.

## Result 2 — vscode (**not an internal workspace monorepo**)

vscode's root `package.json` has **no `"workspaces"` field**, and `pnpm`/`yarn`/`npm` workspace globs
don't apply to it. `extensions/*` are independently-installed sibling projects, each with their own
dependencies — there is no internal package-to-package import graph in the npm-workspaces sense to
probe. (A naive "any `package.json` in the tree with a matching name" scan produces **false workspace
membership**: `extensions/typescript-basics/package.json` declares `name: "typescript"` — a built-in
grammar/snippets extension, unrelated to the npm `typescript` compiler — and a test fixture at
`extensions/copilot/test/simulation/fixtures/codeMapper/package.json` declares
`name: "@vscode/prompt-tsx"`. Treating either as *the* resolvable target for a bare specifier of the
same name is a real methodology bug the first draft of this script had, fixed by requiring actual
declared-workspace-glob membership rather than name coincidence.)

The deep imports the earlier research actually found in vscode (`@vscode/prompt-tsx/dist/base/...`)
are against **externally published npm dependencies**, not workspace packages — their manifests live
in `node_modules`, which this checkout does not have installed (by design, per the task). So the
broad scan (any bare-specifier deep import, workspace or not) is the only thing that can be measured
here, and **for every one of its 51 hits, `manifest_resolvable = false`** in this environment: Arm B
cannot execute at all, on any of them, as things stand.

| | count |
|---|--:|
| Arm A raw hits (broad scan) | **51** |
| Resolvable manifest in-repo | **0** |
| Unresolvable (external dep, no `node_modules`) | **51** |

To find out what Arm B *would* do if `node_modules` existed, the real `package.json` for every
distinct target package (8) was pulled from the npm registry (not recalled from training data —
fetched live) and hand-checked against the actual subpath used:

| target package | hits | real `exports` field? | subpath declared? | Arm B would... |
|---|--:|---|---|---|
| `typescript` (pinned `^5.8.3` in `extensions/copilot`) | 31 | **no** (`main`+`typings` only; `exports` was added much later, v6+) | n/a | **inert** — flags same as Arm A |
| `@vscode/prompt-tsx` | 11 | **no** (`main`+`types` only) | n/a | **inert** — flags same as Arm A |
| `mocha` | 4 | **no** (no `main`/`types`/`exports` at all) | n/a | **inert** — flags same as Arm A |
| `vscode-languageserver-protocol` | 1 | yes (`.`, `./node`, `./browser` — no wildcards) | no (`lib/common/protocol` isn't one of the 3 declared files) | still flags (TP either way) |
| `image-size` | 1 | yes (`.`, `./fromFile`, `./types/*` wildcard) | no (`dist/types/interface` doesn't match `./types/*` — stale pre-refactor path, missing the `dist` segment the export never had) | still flags (TP either way) |
| `trusted-types` | 1 | **no** | n/a | **inert** |
| `@vscode/sync-api-common` | 1 | **no** | n/a | **inert** |
| `markdown-it` | 1 | yes, `"./*"` wildcard covers everything | **yes** | **only vscode hit Arm B would suppress** |

**Net: even with real registry manifests substituted in — i.e. simulating the best case where
`node_modules` was installed — Arm B changes exactly 1 of 51 decisions (2%).** Same order of magnitude
as n8n's 1/42 (2.4%).

**A separate, important finding this surfaced, orthogonal to Arm A vs B:** `typescript` (31 of 51
hits, 61% of the vscode sample) and `mocha` (4 hits) are both packages with **no `exports` field at
all**, where the specific deep path used (`typescript/lib/tsserverlibrary`, `mocha/lib/reporters/base`)
is each vendor's own **documented, intentional** multi-entrypoint convention (TypeScript ships
`tsserverlibrary` as an official second entrypoint for building language-service tooling; Mocha's own
docs tell you to extend `mocha/lib/reporters/base` for custom reporters). These are very likely false
positives for the marker heuristic — and **neither arm can fix them**, because there's no `exports`
field for Arm B to consult either way. This FP class needs a different mechanism entirely (a
documented-convention allowlist), not exports parsing, and it's the dominant driver of vscode's raw
hit count.

## The verdict — blunt

**Arm A (dumb, zero manifest reads) is already doing essentially all of the useful work. The
exports-parsing machinery is not justified by this evidence.**

1. On n8n — the *best case* for Arm B (a true workspace, every manifest resolvable in-repo, no
   `node_modules` dependency at all) — it changes **1 of 42** raw decisions, and that one suppression
   is a permissive `"./*": "./*"` self-mapping escape hatch, not a curated subpath declaration.
2. On vscode — the case the original research actually cited as evidence for this rule — Arm B is
   **completely inert in this environment** (no `node_modules`), and hand-verifying against the real
   published manifests shows it would change only **1 of 51** decisions even in the best case.
3. In neither sample does exports-awareness touch the dominant false-positive driver. On vscode that
   driver (`typescript`/`mocha`, 69% of the raw hits) has no `exports` field to consult at all — the
   machinery is structurally unable to help with the FP class that actually matters there.
4. Arm B literally cannot run for the external-dependency case without `node_modules` installed. That
   is exactly the false-green class reconciled-build-order item #1 exists to gate — building Arm B
   before item #1 ships risks a second, rule-specific instance of the same silent-false-green failure
   mode.

**Recommendation:** ship `arch.import-provenance` v1 as **Arm A only** — marker-based, zero manifest
reads, applies identically to workspace and external targets. Hold exports-aware wildcard suppression
in the Design Reserve. Promotion trigger: a repo where the exports-suppression rate is *materially*
higher than the ~2% measured here (e.g., heavy, deliberate use of curated non-wildcard subpath
exports, not blanket `"./*"` escape hatches) — not before.

## Correction to the prior hypothesis (`reconciled-build-order.md` #4, `spike-findings.md` Rule B)

The earlier "n8n 466 raw → ~15-20 est. TP once wildcards respected" number was never a measurement of
*this* Arm A — it came from a strictly dumber prior detector (`spike.py`'s `rule_B`) that flagged **any
undeclared subpath**, marker or not, whenever the target package happened to declare *some* `exports`
subpaths. Its FP flood was dominated by `@n8n/rest-api-client`'s `"./*"` wildcard being ignored — i.e.
ordinary, non-internal imports that were never within hailing distance of `/src/dist/lib/internal`
were being flagged as violations. **Scoping the string match to the four marker segments (still zero
manifest reads) already eliminates that FP class before exports-parsing ever enters the picture** —
42 hits on n8n, not 466, with no exports awareness at all. The "466 → ~15-20" hypothesis measured the
wrong fix for the wrong baseline; the real fix was a narrower dumb rule, not a smarter one.

## Methodology notes / limitations

- Import extraction is regex-based (`from '...'`, `require(...)`, dynamic `import(...)`), not a real
  parser — a throwaway-probe-appropriate shortcut per this repo's spike discipline, not production
  quality.
- n8n's workspace membership was built from `pnpm-workspace.yaml`'s declared globs. vscode's was
  correctly determined to be empty (no `workspaces` field) after an earlier draft's naive
  any-`package.json`-with-a-name approach produced false matches (`typescript`, `@vscode/prompt-tsx`
  name collisions with unrelated in-repo fixtures/extensions) — see Result 2.
- Hand-checking was a representative sample (4 n8n hits verified against source; all 8 distinct vscode
  target packages verified against real npm-registry manifests), not exhaustive verification of all 93
  raw hits combined, consistent with this repo's "raw counts are NOT the result" discipline.
- Test/spec files and `.d.ts` files were excluded from the *importer* scan; build-output directories
  (`dist`, `build`, `out`, `.turbo`) were excluded from the walk (they are generated, not source), which
  does not affect the specifiers being matched (those still reference `dist`/`lib` as part of the
  bare-specifier string, which is untouched by which directories are walked for source files).
