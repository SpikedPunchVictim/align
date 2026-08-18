# Exploration: could align reduce documentation-review toil?

**Status: exploration, not a proposal to build.** Captures a direction and two evidence probes so a
future ADR (if any) starts from measured ground, per promotion-on-evidence doctrine.

## Why look at documentation at all

The enterprise-repo PR-comment research (`pr-research/`) found **documentation was the single largest
review-comment category** (~18% broad / 11% on the tighter filter), and **~62% of those comments are
bot-authored** (Copilot/CodeRabbit). That bot-authorship share is the real signal: when an LLM
generates a large PR, it writes the code *and* the docs/metadata, and it reliably botches the
*structural* consistency between them — wrong semver bump, a forgotten API-report, a doc link to a
file it just renamed. Those are exactly the mechanical, high-frequency comments that eat human review
time on LLM-generated code.

The strategic bet (owner-framed): if align can turn that class of toil into a **deterministic red loop
the agent fixes before a human ever sees the PR**, it reduces review burden and drives adoption —
because it targets the boring-but-necessary comments no one enjoys writing.

## The reframe: align does doc-*code consistency*, never prose

Reading the actual doc comments (not just keyword buckets) splits them cleanly:

- **Doc-code CONSISTENCY (deterministic, graph-/metadata-derivable — align-shaped):** a documentation
  or metadata artifact that must track a structural fact align already computes. align never judges
  whether prose is *good*; it checks whether an artifact is *consistent with the code graph*.
- **Prose / JUDGMENT (out of align's lane):** wording, grammar, tense, "reword the changeset summary,"
  "explain why not what," whether a comment is *helpful*. This is the LLM-reviewer's job; competing
  there is the mistake.

Every candidate below is the first kind. The concrete consistency errors observed:

| Concrete error (real dataset-a comments) | Deterministic? |
|---|---|
| Changeset declares `patch` but the PR adds a public export (should be ≥minor) | ✅ (needs surface delta) |
| New/changed public export, but `report.api.md` / `.d.ts` not regenerated | ✅ (needs surface) |
| A doc link points to a file that doesn't exist (renamed/moved) | ✅ (file graph) |
| A `@public` export has no JSDoc (`@public (undocumented)`) | ✅ (surface) |
| Comment/README "says the old thing" after a behavior change | ⚠️ mostly judgment |
| Changeset summary wording / tense / grouping | ❌ judgment |

Notice the align-shaped ones are a **family on top of ADR-016 public-surface inference** (already
built), plus one that reuses `align build`'s markdown parser. This is not a new pillar — it's existing
structural facts applied to the artifacts that must stay consistent with them.

## The two probes (measured, not asserted)

### Probe A — doc-reference integrity (broken doc links) — `evidence/doc-consistency-probe/DOC_REFERENCE_PROBE.md`
- Naive "does every local link resolve?" = ~10.5% broken, but **high false-positive rate** from
  docs-site routing (backstage Next.js `/components/box`, strapi Docusaurus `/docs/...` are *routes*).
- **High-precision subset (relative-file links): 5.9% broken (148/2495), hand-checked.** backstage — the
  most doc-disciplined repo — is **0/1561**; broken links cluster in less-disciplined repos (nest 27/39,
  vscode 84/622).
- **align-shaped core:** relative link (with an extension) to a source/doc file that doesn't exist — the
  *"renamed the file, left the doc pointing at the old path"* case. Exactly the LLM-toil pattern; a real
  reviewer caught this verbatim in the dataset.
- **Cost:** cheapest candidate. Reuses `align build`'s markdown parsing + the file graph. **No
  dependency on surface inference and no new architectural surface.**
- **Caveat:** precision needs *docs-site awareness* (detect Docusaurus/Next-app roots) + a configurable
  policy for subpackage-README→repo-root convention links (`CONTRIBUTING.md`, `LICENSE`).

### Probe B — changeset ⟷ semver consistency — `evidence/doc-consistency-probe/CHANGESET_SEMVER_PROBE.md`
- Of a hand-read sample (n=40 of 128 keyword matches): **only 15% deterministically addressable**, 25%
  judgment/prose, **60% keyword false positives** ("minor nit," "patch" as a verb).
- **59% of all matches come from just 2 repos (backstage, astro)** — both changeset-culture and already
  reviewing this by hand/bot. Narrow, tooled-market concentration.
- **Mechanism:** inputs are parseable (`.changeset/*.md` frontmatter) and ADR-016's `inferSurface.ts`
  gives a single-snapshot surface (does *not* need the promotion-gated `.align/public-surface.json`).
  But the rule needs a surface **delta** (base vs PR), which requires **scanning a git ref other than
  the working tree — a mechanism align has *zero* of today** (verified: no `git show`/`scanRef`/ref
  primitives anywhere). That two-ref graph scan is genuinely new architectural surface, and it's the
  real blocker — not the persisted-surface artifact.
- Real (not illustrative) worked example exists (backstage `Combobox` export added under a `patch`
  changeset), with a pre-1.0 caveat.

## Recommendation & sequencing

**Lead with doc-reference integrity (Probe A).** It is the cheapest, broadest, and most universal — it
works on any repo with markdown docs (not just changeset-culture ones), reuses infrastructure align
already has, adds no new architectural surface, and catches the most mechanical LLM-toil comment
(dangling link after a rename). The shippable rule is the *relative-file-with-extension* core + docs-site
awareness, not the naive check.

**Treat changeset⟷semver (Probe B) as a narrow, later candidate**, gated on (a) demand beyond the two
changeset-culture repos and (b) building **two-ref graph scanning** — which is a larger investment that
would *also* unlock impact-analysis / `align check --changed` and any future "what did this PR change
structurally" feature. Don't build it for the changeset rule alone; build it when the two-ref capability
is justified on its own, then this rule rides on top.

**Reserve (surface-inference family, cheap once pursued):** api-report freshness and
public-export-documented both reuse ADR-016's single-snapshot surface with no two-ref requirement — but
both are api-extractor-culture-concentrated, so they wait on evidence of broader demand.

**Explicitly out of scope (forever):** prose quality, wording, grammar, changeset summary phrasing,
"explain why," comment helpfulness. Judgment work the LLM reviewers own.

## If pursued: the doc-reference rule shape (sketch, not committed)
A new gate/rule kind `docs.link-integrity` (or a `custom.host`-expressible predicate first, per the
external-edges promotion precedent): parse markdown docs (reuse `align build`'s parser), extract
relative-file links, resolve against the scanned file graph, flag non-existent targets. Docs-site
awareness (skip/resolve Docusaurus/Next-app roots) and a configurable root-convention policy are the
precision-critical parts. Would get its own ADR + a real TP/FP validation pass before promotion.

## Honest caveats
- Both probes are on elite OSS with mature doc tooling — the "untooled repo" (align's stated market)
  likely has *more* broken links and *fewer* changesets, so Probe A's real-world value is probably
  higher and Probe B's lower than these numbers.
- "Documentation" as a headline is a judgment-heavy space; align's credible slice is deliberately
  narrow (consistency, not quality). Overreaching into prose would dilute the tool's deterministic
  identity — the same discipline that keeps `custom.host` from becoming a linter.
