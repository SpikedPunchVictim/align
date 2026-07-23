# Probe: Changeset ⟷ Semver Consistency as an align Rule

**STATUS: THROWAWAY EVIDENCE SPIKE. No production code was written.** This document and the
classification data behind it are the entire deliverable. Nothing here is wired into align's
rule engine, DSL, or CLI.

**Hypothesis under test**: "A deterministic align rule could catch: a PR changes a package's
public API surface (adds/removes/changes a public export), but its changeset declares a semver
bump that doesn't match, or has no changeset at all." Proposed mechanism: reuse ADR-016's
public-surface inference + parse `.changeset/*.md`.

**Verdict up front**: **weak-to-moderate — worth a narrow, opportunistic build, not a priority
rule.** The addressable fraction is real but small (15% of an already keyword-filtered sample,
concentrated in 2 of 9 repos), and the mechanism needs a base-vs-PR surface *delta* that ADR-016
has not built (only a single-snapshot surface computation exists today). See bottom line for the
full reasoning.

---

## Task 1 — classifying the real review comments

**Method**: grepped `/Users/spikedpunchvictim/temp/enterprise-apps/pr-research/dataset-a-github-pr-comments/all-comments.jsonl`
(3,000 lines, one JSON object per line — the file parsed cleanly with a plain per-line
`json.loads`, no multi-line records encountered) for `changeset|changelog|semver|\bbump\b|\bminor\b|\bmajor\b|\bpatch\b`
(case-insensitive). 128 of 3,000 lines matched. Hand-read a random sample of 40 (seeded,
reproducible) of the 128.

**Repo concentration of the 128 keyword matches** (this alone is a finding): 38 backstage, 38
astro, 17 vuejs/core, 14 storybook, 6 react, 6 next.js, 4 angular, 4 nest, 1 vscode. **Two repos
— backstage and astro — account for 59% of every keyword match in the entire 9-repo, 3,000-comment
dataset.** Both are Changesets-tooled repos with an active bot (backstage: a "Copilot" review bot
running PR-description/diff/changeset consistency checks) or an engaged core-team reviewer
(astro: `ArmandPhilippot`/`ematipico` manually gatekeeping changeset content on nearly every PR).
Every single Task-1 example below, in both class A and class B, comes from these two repos.

### The A/B/C split (n=40)

| Class | Count | % of sample |
|---|---|---|
| **(A) Deterministically addressable** | 6 | 15% |
| **(B) Judgment/prose** | 10 | 25% |
| **(C) Other / false positive** | 24 | 60% |

**Honest caveat on the C bucket**: most of the 24 "C" items are not "changeset comments that
don't fit the hypothesis" — they are keyword false positives. The regex catches the common
English words "minor"/"major"/"patch" used in entirely unrelated contexts: severity badges
("🟠 Major", "🟡 Minor" from CodeRabbit/Vercel bots), "patch" as a verb ("patch our agent
detection library"), "minor nit" as a generic modifier, and a real `semver.gte()` code-review
comment about TypeScript version comparison logic (not a package's own changeset). This means
**the true addressable fraction of "changeset/semver-flavored PR comments" is 6 of the ~16 (A+B)
that are actually about changesets at all — roughly 38%** — but as a fraction of everything a
naive keyword grep pulls in, it's 15%. Report both; the second number is what a real triage
workflow would see.

### (A) Deterministically addressable — 6 examples, quoted verbatim

These are cases where a rule comparing "did the package's public surface change" against "what
bump level (if any) does the changeset declare" would have produced the same finding a human
reviewer produced by hand.

1. **Bump-level-too-low, breaking change** (backstage, Copilot bot) — the canonical case:
   > "This PR adds a new required `auditor` field to the exported `KubernetesProxyOptions` type
   > (see `plugins/kubernetes-backend/report.api.md`), which is a breaking change for downstream
   > consumers that construct `KubernetesProxy` directly. With `@backstage/plugin-kubernetes-backend`
   > currently at version 0.21.6, this should be a **minor** changeset (or alternatively the new
   > field should be made optional with a safe default)."

2. **Missing changeset entirely, new public API** (backstage, Copilot bot):
   > "This PR adds a new exported public API (`auditorMiddlewareFactory`) and new runtime behavior
   > in the published package `@backstage/backend-openapi-utils` (publishConfig.access is public),
   > which requires a changeset under `/.changeset` per the contribution guidelines
   > (`CONTRIBUTING.md:223-233`)."

3. **Changeset covers the wrong package** — one public package changed, changeset covers a
   different one (backstage, Copilot bot):
   > "This changeset only bumps `@backstage/plugin-techdocs`, but this PR also changes the public
   > `@backstage/plugin-techdocs-react` package (the reader page provider retry behavior + tests).
   > To ensure consumers receive the fix, include `@backstage/plugin-techdocs-react` in the
   > changeset (patch)."

4. **Missing changeset, asked directly** (astro, human reviewer `ematipico`):
   > "Should we have a changeset for the new API and the deprecation?"

5. **Missing changeset, version-bump PR** (astro, human reviewer `ArmandPhilippot`):
   > "I'll review this in details tomorrow (CET), but the version should be v7 and the PR is
   > missing a changeset."

6. **Inverse case — a spurious/over-broad changeset** (backstage, Copilot bot), i.e. the changeset
   declares a change to a package the diff doesn't actually touch:
   > "This PR is described as a docs-only change to remove `await` from `renderInTestApp` examples,
   > but it also adds a changeset for `@backstage/backend-defaults` describing a scheduler/metrics
   > behavior change. If this PR doesn't actually change backend behavior, this changeset should be
   > removed (or moved to the PR that contains the backend change)."

Note example 6 is the mirror image of the hypothesis (changeset present but not backed by an
actual surface change, rather than surface change with no/wrong-level changeset) — same
mechanism (diff the packages a changeset names against the packages the diff actually touches),
opposite direction. Worth folding into the same rule since it reuses identical inputs.

### (B) Judgment/prose — not align-shaped — 3 of 10 quoted

1. (backstage, Copilot bot) — wording ambiguity, not a bump/surface mismatch:
   > "The changeset summary is a bit ambiguous (it reads like the catalog now rejects duplicate
   > keys, rather than fixing duplicated casing-conflict key names in the error message). Consider
   > rewording to describe the user-visible behavior change more precisely."

2. (astro, `ArmandPhilippot`) — asking for more marketing emphasis on a breaking change, pure
   copywriting judgment:
   > "...because this a new feature, we might want to hype it in the changeset... Maybe something
   > like: [500-word rewritten changeset draft]..."

3. (astro, `ArmandPhilippot`) — organizational preference, not correctness:
   > "Should this be multiple patch changesets instead? It seems easier to scan for users if they
   > each have their own entry rather than listing them at the end of this changeset."

The other 7 in this bucket are the same shape: changeset-copy wording nits, "should this be
grouped/split differently," a changeset filename typo, and rewrite suggestions for clarity/tone.
None of them are reachable by a bump-vs-surface-delta check; all require reading the prose meaning
of the summary, which is out of scope for a static rule.

### (C) — representative false positives (not full list)

- `"Additional minor nit: the <TContext> generic does nothing here"` (angular) — "minor" as a
  plain adjective.
- `"🟠 Major | 🟡 Minor"` severity badges on unrelated CodeRabbit/Vercel-bot findings (vuejs/core,
  next.js, storybook) — matched on the badge text, not on any changeset discussion.
- `"This version check could be done with our semver dependency"` (storybook) — `semver` as an
  npm package name in a code-style comment, not a PR-level bump discussion.
- A `failOnError`/`failOn` deprecation history quoted from a *third-party library's* own changelog
  (astro, `sharp`) — describes someone else's changelog, not this PR's.

---

## Task 2 — mechanism feasibility on Backstage (a real Changesets repo)

### Input format, confirmed

`/Users/spikedpunchvictim/temp/enterprise-apps/backstage/.changeset/` has 99 pending `.md` files
plus `config.json`/`README.md`/`backstage-changelog.js`. `config.json`:

```json
{
  "$schema": "https://unpkg.com/@changesets/config@1.3.0/schema.json",
  "changelog": "./backstage-changelog.js",
  "commit": false,
  "linked": [],
  "access": "public",
  "baseBranch": "master",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

Every pending changeset file is:

```markdown
---
'@backstage/eslint-plugin': minor
---

Added a new `no-self-package-imports` lint rule, enabled as `error` in the recommended config...
```

**Exact parse target**: a YAML frontmatter block (`---` delimited) whose body is a flat map of
`'@scope/pkg-name': patch|minor|major` pairs (one or more packages per file — confirmed a real
5-package file, `add-missing-transitive-deps.md`), followed by a free-text Markdown body (the
changelog entry). This is a trivial, well-specified parse — no ambiguity, no need for the
`@changesets/parse` package even, a plain frontmatter split suffices.

### The surface-delta dependency — what's built vs. what's missing

Read `docs/adr/016-public-surface-inference.md` and the two modules it names,
`packages/core/src/surface/inferSurface.ts` and `packages/plugin-typescript/src/entrypoint.ts`,
plus the pure diff precedent `packages/agent/src/symbolDiff.ts`.

**What ADR-016 built (confirmed, "STATUS: ACCEPTED & BUILT (pure algorithm)")**:
- `inferSurface(graph: DependencyGraph, packageName: string, entrypoints: PackageEntrypoint[]) =>
  PackagePublicSurface` — a pure, already-tested (backstage: 99.67% precision / 100% recall
  against ground truth) function that computes **one package's complete public surface from one
  already-materialized `DependencyGraph`**. This is a single-snapshot computation: give it a
  graph, get back "everything publicly reachable right now."
- `entrypoint.ts` — the impure shell that reads `package.json` and produces the
  `PackageEntrypoint[]` `inferSurface` needs, again for **one** snapshot of the repo (whatever's
  checked out when the scanner runs).

**What is explicitly NOT built (ADR-016's own text, verified by `grep` — zero hits for
`public-surface.json`, `surface infer`, or `PublicSurfaceInferrer` anywhere outside the ADR/type
files)**: the CLI command, the persisted `.align/public-surface.json` artifact, the confirmation
gate, and the DI wiring. ADR-016 frames these as **promotion-gated on a prevented-autofix case**
that has not happened yet.

**The rule this probe is testing does NOT need the persisted artifact for its core mechanism** —
that's a distinct question from whether it needs a *delta*. It needs:

> `PackagePublicSurface` computed against the PR's **base** ref, and `PackagePublicSurface`
> computed against the **PR/working** ref, then diffed.

Both snapshot computations are exactly what's built today (`inferSurface` is pure and callable
twice against two different `DependencyGraph`s). **What's missing is the diff function itself and
the two-ref materialization**:

1. **No `diffPublicSurface(before, after)` exists.** The one real precedent,
   `diffExportedSymbols` in `packages/agent/src/symbolDiff.ts`, is the right shape (pure,
   before/after, "removed" as the interesting case) but operates on flat
   `SymbolTableEntry[]` — a raw per-file export list from a single in-process fix-loop
   transformation — not on `PackagePublicSurface`, and it has no notion of package identity,
   entrypoint confidence, or "added" (only "removed", since its job is autofix-safety, not
   semver classification). Writing a `PackagePublicSurface`-aware version that reports **added**
   symbols too is new, small, straightforward work — but it does not exist and would need to be
   built and tested (it inherits `inferSurface`'s validated confidence contract, so this part is
   low-risk).
2. **No mechanism exists anywhere in align to scan a non-working-tree git ref.** `grep`ped
   `packages/*/src` for `merge-base`, `baseRef`, `git show`, `worktree add` — zero hits. Every
   `align check`/`align build` invocation scans whatever is on disk right now. To get a "before"
   `DependencyGraph`, something has to materialize the base ref (a `git worktree add` /ephemeral
   checkout, or `git show <base>:<path>` per file) and run the *scanner* (not just
   `inferSurface`) against it. This is ordinary, solvable CI-glue work with real prior art
   elsewhere (every diff-coverage tool does this), but it is unbuilt and untested inside align
   specifically, and it's the actual bulk of the missing mechanism — bigger than the diff
   function itself.

**Bottom line on feasibility**: the hard, validated, precision-measured part (surface inference
itself) is done and doesn't need the promotion-gated persisted-artifact machinery. The part
that's missing is unglamorous but real: (a) a small new pure diff function, well-precedented by
`symbolDiff.ts`, and (b) two-ref graph materialization, which align has never done in any form.
**(b) is the actual gap, not the persisted-artifact question the ADR gates on.**

### Worked example — real, not hand-built

Found by grepping backstage's 99 pending changesets for a `patch`-bump file whose body describes
adding something new, then verifying against `git log`/`git show`:

`.changeset/whole-bees-wave.md`:
```markdown
---
'@backstage/ui': patch
---

Added a new `Combobox` component. It pairs a text input with a filterable dropdown of options
and supports single selection, sectioned options, icons, sizes, and custom typed values via
`allowsCustomValue`.
```

This changeset was introduced in a single real commit, `ddca41f775dc` ("Add Combobox component to
Backstage UI (#34118)"). The diff for that commit:

- adds `.changeset/whole-bees-wave.md` (declaring **patch**)
- adds the new component files under `packages/ui/src/components/Combobox/`
- adds the export line to the package's public entrypoint:
  ```diff
  --- a/packages/ui/src/index.ts
  +++ b/packages/ui/src/index.ts
  @@ -43,6 +43,7 @@ export * from './components/ButtonIcon';
   export * from './components/Checkbox';
   export * from './components/CheckboxGroup';
  +export * from './components/Combobox';
   export * from './components/RadioGroup';
  ```
- adds **106 lines to `packages/ui/report.api.md`** — Backstage's own API-Extractor-generated
  public API report — independently confirming (via Backstage's *own* tooling, not align's
  inference) that this is a genuine, non-trivial public surface addition.

Running ADR-016's inference on the graph before vs. after this commit: `inferSurface` on the
"after" graph produces a new `PublicSurfaceEntry` for symbol `Combobox` (and its sibling exports
`ComboboxInput`, etc.), `declaredIn` the new file, `reachableVia` the barrel hop through
`index.ts`, at `confidence: 'declared'` (`@backstage/ui` has a real `package.json` `exports`
field). The "before" graph has no such entry. A `diffPublicSurface` would report: **1 package,
1+ new export, changeset says `patch`.**

**The rule fires**: adding a new named export to a public entrypoint is, under standard semver
(and under Changesets' own contribution docs, which Astro's contributor guide — quoted in Task 1
— explicitly frames as "hype new features in the changeset," i.e., treats new features as
minor-or-above) a backward-compatible feature addition, which should be **minor**, not **patch**.
This PR's changeset would be flagged: `should be >= minor`.

**One caveat, stated plainly**: `@backstage/ui` is at `0.15.0-next.2` — pre-1.0, on a `next`
prerelease channel. Under strict semver, 0.x minor bumps carry different (weaker) compatibility
guarantees than 1.x ones, and some teams treat a 0.x "minor" almost like a "major." That doesn't
change what the *changeset tool* records (it still has three discrete levels: patch/minor/major,
regardless of the package's major version), so the mechanical mismatch is still real and still
flaggable — but a rule author should decide up front whether 0.x packages are in scope, since the
semver-severity argument is genuinely softer there than for a 1.x+ package.

---

## Bottom line

**Worth pursuing, but as a narrow, low-priority rule, not a flagship one — and not yet, given
what's missing.**

- The addressable fraction is real (backed by 6 concrete, independently-verifiable examples
  including one canonical "breaking change under-declared as a lower bump" case) but small: 15%
  of a keyword-filtered sample, or ~38% of the sample that's actually about changesets once
  keyword-false-positives are excluded. Either way, most changeset/semver-flavored PR discourse
  (60% raw, and 63% of the true on-topic subset) is prose/wording judgment or unrelated noise a
  static rule cannot and should not try to replace.

- **The single biggest limitation is market concentration, not the mechanism.** 59% of every
  keyword match in a 9-repo, 3,000-comment sample came from just 2 repos (backstage, astro) — both
  already have a human or bot doing this exact review by hand. This rule's addressable population
  is "repos that use Changesets (or an equivalent) *and* have public API surfaces worth tracking
  *and* don't already have a reviewer/bot doing this." That is a narrower slice of align's stated
  target market (untooled, mid-size repos — see ADR-016's own framing) than the rule's design
  effort would suggest; a repo with no changeset culture at all gets zero value from this rule
  and a repo that already gatekeeps changesets by hand (astro) gets marginal value.

- **The mechanism is feasible without the promotion-gated persisted-surface artifact** — that's a
  real, evidence-backed finding this probe can hand back to ADR-016's own promotion question: this
  rule does NOT need `.align/public-surface.json`, so it is not a valid promotion-evidence case
  for that artifact. What it does need — a `PackagePublicSurface`-level diff function, and
  the ability to materialize a `DependencyGraph` for an arbitrary git ref instead of only the
  working tree — is unbuilt in both cases, and the second one (two-ref scanning) is new
  architectural surface for align, not a small addition, and has never been exercised by any
  existing align rule.

- Monorepo package attribution (which package "owns" a given surface change, and whether a
  changeset's package list needs to include downstream re-exporters like the
  `plugin-techdocs`/`plugin-techdocs-react` example) is a second real complexity: example 3 in
  Task 1 shows a human reviewer reasoning about *transitive* consumption ("to ensure consumers
  receive the fix"), which is a harder, less mechanical judgment than "this package's own surface
  changed" — a first version of this rule should scope tightly to "the package whose own files
  changed," and treat cross-package propagation as an explicit non-goal, or it will both over- and
  under-fire.
