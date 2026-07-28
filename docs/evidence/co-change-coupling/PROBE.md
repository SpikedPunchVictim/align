# Probe: co-change coupling vs. the import graph

**Question (from the dev-loop review):** align governs the *import* graph (dependency-direction,
cycles). Git history reveals a *different* coupling — files/packages that **change together**. Where
they diverge — high co-change but **no import edge** — is coupling align's model can't see. How big is
that gap, and is any of it something align should govern?

**Method:** for each repo, map every commit's changed files → owning workspace package; accumulate
pairwise package co-change over ~5,000 recent commits; build the direct cross-package import graph at
HEAD; classify each co-change pair as *import-coupled* (edge either direction) or *hidden* (no direct
edge). `git log --name-only` + package-name import scan; ~a day's tooling, matching the review's
estimate.

## Result — the import graph captures a MINORITY of real coupling

| repo | commits | pkgs | import edges | co-change mass: import-coupled | **hidden (no edge)** |
|---|--:|--:|--:|--:|--:|
| backstage | 4,985 | 255 | 1,490 | **7%** | 93% |
| directus | 4,995 | 42 | 101 | 22% | 78% |
| n8n | 4,998 | 75 | 198 | 31% | 69% |

Consistent across three different architectures: **most of what changes together is not connected by an
import edge.** But the headline number over-claims until the hidden mass is decomposed.

## What the "hidden" coupling actually is (the discipline)

Reading the top hidden pairs, the 70-93% is four classes — and three of them are *correctly* invisible
to an import-based model:

1. **Inherent full-stack co-change** — `n8n ↔ n8n-editor-ui`, `@directus/api ↔ @directus/app`
   (backend + frontend for one feature). Genuinely no import edge (separate runtimes, communicate over
   an API), and there *shouldn't* be one. Not a gap; not align-governable.
2. **Ecosystem / release-cadence co-change** — backstage's plugins
   (`plugin-api-docs ↔ plugin-scaffolder ↔ plugin-techdocs`, P 56-84%). Independent packages that
   co-change because they share the framework contract and a release cadence, **not** because they
   depend on each other. This is 93% of backstage's mass — and it's convention, not architecture.
3. **Test ↔ code** — `n8n-editor-ui ↔ n8n-playwright`. E2E tests track the UI they exercise. Inherent.
4. **Implicit contracts (the sharp, genuinely-interesting residue)** — pairs bound by a contract that
   isn't an import: `@n8n/rest-api-client ↔ n8n` (P=76% — frontend client must match backend),
   `@directus/extensions-sdk ↔ create-directus-extension` (**P=96%** — a scaffolder that generates code
   against an SDK must track it), `@directus/api ↔ @directus/extensions-sdk` (P=68%). This is real
   coupling **no import-based tool can see** — but it's a *minority* of the hidden mass.

Caveat that shrinks "hidden" further: the edge set is **direct** imports only. Two backstage plugins
that both import `@backstage/core-plugin-api` but not each other are transitively coupled through the
shared dep — counted "hidden" here but not truly independent. So the true no-coupling-path fraction is
smaller than the table's "hidden."

## What this means for align (honest, non-inflated)

- **Positioning correction, not a feature.** align's import-graph model is a *partial* view of coupling
  — it should not claim to catch "all architectural coupling." Co-change and import coupling are largely
  *different axes*; align owns the import axis, and most of the other axis (full-stack, ecosystem
  cadence, tests) is inherent and correctly outside its remit. Say this plainly rather than overclaim.
- **The genuine residue is small and of unclear actionability.** The implicit-contract pairs
  (SDK↔scaffolder, client↔server) are real coupling align can't see — but there is no obvious align
  *rule* for them (you can't forbid or redirect a coupling that has no import edge). At most they're a
  **rule-*suggestion* input**: "these change together at P≥N with no import edge and aren't test/full-
  stack — is there an undocumented contract that should be typed/enforced?" — a human prompt, not a gate.
- **The clearer near-term use is the OTHER 7-31%.** For import-*coupled* pairs, co-change frequency
  *prioritizes* which dependencies matter — a signal for lever 3a (suggest/rank dependency-direction
  rules on the edges that actually churn together), not a new coupling kind.

## Verdict

Co-change mining is a valuable **diagnostic** — it shows the *shape* of coupling and correctly reveals
that align sees a minority of it. But, like the doc-consistency probe, the evidence tempers the
enthusiasm: it does **not** hand align a new feature. Its honest payoffs are (a) accurate positioning
about align's model boundary, and (b) a prioritization signal for suggesting dependency-direction rules
on the import-coupled churn. The "implicit contract" residue is real but small and lacks an obvious
enforcement mechanism — a reserve curiosity, not a build.
