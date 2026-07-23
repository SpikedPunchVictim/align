# Probe: doc-reference integrity (broken links in markdown docs)

**Question:** could a deterministic align rule catch the "a doc links to a file/path that doesn't
exist" class of review comment — e.g. the real dataset-a comment *"This link points to
`./09-troubleshooting-app-visualizer.md`, but that file does not exist… the migration guide is
broken"* — and how much of it is genuinely align-shaped vs. false-positive noise?

Throwaway; spike-before-build. Scanned markdown across 8 enterprise repos
(`/Users/spikedpunchvictim/temp/enterprise-apps/{backstage,n8n,vscode,directus,strapi,nest,langchainjs,opentelemetry-js}`).

## The TP/FP story (this is the result, not the raw count)

A naive "does every local markdown link resolve on disk?" check reports **~10.5% broken** — but that
number is **inflated by false positives** I had to strip:

1. **Docs-site framework routing.** backstage's `docs-ui` (Next.js app) and strapi's `docs/` (Docusaurus)
   use root-relative links like `/components/box`, `/docs/core/database/...` that are *site routes*,
   not filesystem paths. A file-existence check wrongly flags them. (backstage went from "15 broken"
   to **0** once these were excluded.)
2. **Custom URI schemes** — `vscode:`, `vscode://`, `data:` — not file links.
3. **Generated/fixture docs** — vscode's `test/simulation/fixtures/gen/CHANGELOG.md` etc. — noise, not
   real docs.

**High-precision subset — relative-file links only** (`./`, `../`, or a bare name with a file
extension; fixtures excluded): **148 / 2495 broken = 5.9%.** Hand-checked; the residual is mostly real.

| repo | broken / relative-file links | note |
|---|--:|---|
| backstage | **0 / 1561** | the most doc-disciplined repo — clean |
| langchainjs | 1 / 5 | |
| opentelemetry-js | 3 / 42 | doc → moved source file |
| strapi | 6 / 46 | some extensionless Docusaurus slugs (residual FP) |
| directus | 7 / 77 | deep `../../api/src/*.ts` refs |
| n8n | 20 / 103 | subpackage README → repo-root files |
| vscode | 84 / 622 | doc → moved/renamed source files |
| nest | 27 / 39 | translated-README links (`readme_zh.md`) that don't exist |

## The genuinely align-shaped, high-value core

The unambiguous true positives — and the ones that map to real toil on LLM-generated PRs — are
**relative links (with an extension) to a source or doc file that doesn't exist**, i.e. *"someone
renamed/moved the file and left the doc pointing at the old path."* Concrete TPs:

- vscode `extensions/copilot/CONTRIBUTING.md → src/extension/prompts/node/agent/agentInstructions.tsx`
- opentelemetry `packages/.../sdk-logs/README.md → ./src/config.ts`
- directus `json-fields.md → ../../../../../../../api/src/database/helpers/fn/dialects/postgres.ts`

This is exactly the LLM-toil case: an agent renames a file in a big PR and leaves a dangling doc link;
a human reviewer catches it (as one did, verbatim, in dataset-a). A deterministic gate turns that into
a red loop the agent fixes before the PR opens.

## Residual false-positive / judgment classes (what a real rule must handle)

- **Extensionless docs-site slugs** (strapi `./container`, `../philosophy`) — Docusaurus doc IDs, not
  files. → the rule needs **docs-site awareness** (detect Docusaurus/Next-app roots, resolve or skip).
- **Subpackage-README → repo-root convention** (n8n/nest `CONTRIBUTING.md`, `LICENSE.md`, `readme_zh.md`)
  — "broken as written from that dir" but a known convention (GitHub/npm render differently). Debatable
  whether to flag; at minimum configurable.

## Verdict

**Real, deterministic, align-shaped — and the cheapest of the doc-consistency candidates** (needs only
markdown parsing, which align already has for `align build`, plus the file graph; **no** dependency on
surface inference). But **precision is not free**: a naive check has a meaningful FP rate from docs-site
routing, so the shippable rule is the *relative-file-with-extension* core plus docs-site awareness and a
configurable policy for the root-convention links.

Value profile: broad (any repo with markdown docs, not just changeset-culture ones), and it catches the
single most mechanical doc-review comment — the dangling link after a rename. backstage's 0/1561 shows
it's a discipline-enforcer: clean repos stay clean, sloppy PRs (LLM-generated included) go red.

**Reproduction:** the throwaway scanner logic is inline in this probe's session; re-run against the
on-disk repos. Two passes: naive (all local links) → high FP; high-precision (relative + extension,
fixtures excluded) → the 5.9% figure above.
