# ADR 003: Components Registry

**Status**: Accepted

## Context

Rules that reference raw globs directly (`c.arch.noDependency('packages/api/**', 'packages/ui/**')`) drift
silently: a directory rename turns the rule into a no-op with zero signal, and every rule referencing that
path needs a coordinated edit. The plan's answer is a top-level `components` map — stable names bound to
selectors once, referenced everywhere else. The spike tested whether that model fits a real repo's layout
or fights it.

Kluster's layout produced three findings that changed the design from the plan's initial framing:

1. **Path prefixes, not package names, are load-bearing.** 13 workspace-orphaned `@fold/*` packages live
   under `packages/workbench/fold/` in no `pnpm-workspace.yaml` glob — package-name binding would have
   silently missed them entirely; path-prefix binding caught them because it doesn't depend on the
   workspace manifest being complete.
2. **A dead alias would have become a phantom component.** The root tsconfig maps `@kluster/shared/*` to a
   directory that doesn't exist. A components model trusting tsconfig paths as ground truth would define a
   component with zero real files behind it.
3. **n8n's 100% zero-config fit** (17,708/17,708 files auto-mapped from `pnpm-workspace.yaml`, probe 4) shows
   package-name binding works *well* when a repo is workspace-disciplined — it's a real, load-bearing mode,
   just not the primary one when a repo isn't.

## Decision

- `components` is a map from stable name → `FileSelector`, where `FileSelector` is `{ kind: 'glob',
  patterns }` **or** `{ kind: 'package', packageNames }` (see `docs/ir-schema.md`). Both selector kinds are
  first-class in the IR; **path-prefix globs are the primary/load-bearing selector kind**, package-name
  binding is a **complement** for workspace-disciplined repos, not the default recommendation.
- **Package-name selectors are validated against the tree at load time** — a `package:` selector naming a
  package absent from the resolved workspace inventory is an error at config-load, not a silent empty match.
  This reuses the same mechanism as empty-selector-fails-by-default (below); no separate validation path.
- **Dead aliases surface as advisories, never phantom components**: an `align doctor`-style check (Design
  Reserve, `IMPLEMENTATION_PLAN.md`) is the eventual home for "alias target missing" detection; in v1, a
  component whose resolved file set is empty triggers the same `.allowEmpty()` gate as any other
  empty-selector case — there is no separate "trusted tsconfig path" code path that could manufacture a
  phantom component.
- **`ComponentRef` is a first-class IR selector variant** alongside raw globs (`docs/ir-schema.md`) — rules
  reference components by name (`ComponentName`, a branded string), never raw globs directly. Rules are
  therefore rename-safe: a directory move is a one-line fix at the component definition, not a scattered
  find-and-replace across every rule.
- **Empty-selector-fails-by-default**: a component whose selector resolves to zero files is a load-time
  error, pointing at the component definition (not at N scattered rules that reference it) — opt out
  explicitly with `.allowEmpty()` for components that are legitimately allowed to be empty on some repos
  (e.g., an optional plugin directory).

## Alternatives considered

- **Package-name binding as the primary selector** (the plan's initial framing, before the spike). Rejected
  by direct evidence: kluster's 13 orphaned packages and dead alias show a repo's package registry can lie
  about what actually lives in the tree; path prefixes don't depend on that registry being accurate.
- **Trust tsconfig `paths` as component ground truth.** Rejected: the dead `@kluster/shared/*` alias would
  have produced a phantom component with a plausible-looking name and zero real membership — a silent
  correctness bug, not a loud one.
- **No registry — rules reference globs directly.** Rejected: this is the selector-drift failure mode the
  registry exists to prevent (Key Risks table, `IMPLEMENTATION_PLAN.md`); a rename silently no-ops every
  rule that referenced the old path.

## Consequences

- `align init`'s component-inference step (ADR 009) defaults to path-prefix detection from workspace layout,
  falling back to package-name binding only where `pnpm-workspace.yaml` coverage is complete (n8n-shaped
  repos) — both selector kinds ship in v1, but the default heuristic order matches the evidence.
- Fixture/generated-tree exclusion (e.g., kluster's `packages/workbench/sdd/apps/**`, ~800 files of pipeline
  test output that structurally looks like source) is explicitly **not** something a components heuristic
  can solve — no layout signal distinguishes a generated app snapshot from a real one. It's a human consent
  decision surfaced in `align init`'s interactive review, not a registry feature.
- Doc-proposed rules (ADR 011) ground selectors against component names, never raw paths — grounding failure
  is visible and actionable rather than a hallucinated path silently matching nothing.

## Evidence

- 13 workspace-orphaned `@fold/*` packages + `packages/workbench/sdd/` outside any `pnpm-workspace.yaml`
  glob (spike Q5, "Components fit").
- Dead alias: `@kluster/shared/*` → nonexistent directory, zero real impact only because no file actually
  imports it (spike Q5 / Q2).
- 8 components, 0/1,755 kluster files unmapped after the three human judgment calls above (spike Q5).
- n8n: 100% zero-config fit via auto-derived workspace-package components, 71 packages discovered in 22 ms
  (probe 4) — the package-name mode's positive case.
- Cross-component edge matrix confirmed real layering: `bt-nodes→bt-core` 194 edges, `api-app→bt-core` 61,
  etc., all directionally consistent with intended architecture (spike Q5).
