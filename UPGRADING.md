# Upgrading align

This document is the authored source for align's migration notes (ADR 022). It is compiled into
the migration registry (`packages/cli/src/migrations/registry.ts`) that `align upgrade` reads —
notes are authored **once, here**, and compiled, never hand-copied into a TypeScript literal that
could drift from this text.

Sections are version-keyed: every `##` heading names exactly one released version (a bare semver,
e.g. `## 0.1.4`), and every `###` heading under it is one migration note. The compiler treats a
misnamed or out-of-place heading as a build failure, not a section it can silently skip.

This document does not tell you what commands to run. It explains what changed and why, factually,
per version. (Guided remediation is `align upgrade`'s job.)

## 0.1.4

### Why violation fingerprints changed

A full-codebase audit fixed 15 bugs. Most need nothing from you. Four of them change how align
computes a violation's *fingerprint* — the identity `.align/baseline.json` uses to recognize a
violation you already accepted. When a fingerprint changes, a previously-accepted violation stops
matching its old baseline entry and reappears as new — not because your code changed, but because
align now describes the same finding differently.

| Rule kind | Why it changed | Scale |
|---|---|---|
| `arch.no-cycles` | The reported cycle is now derived by BFS instead of a greedy walk that could return a path which was not a cycle at all. | Measured across six real repos: **~4%** of multi-node SCCs were reporting a phantom chain and are corrected; another **~1.4%** get a shorter, genuine cycle. |
| `custom.host` | The violation's line number is no longer folded into its fingerprint, so a predicate finding survives reformatting. | Every baselined `custom.host` entry. |
| `arch.no-dependency`, `arch.layers` | `**` in a component selector now matches whole path segments only, so files may reclassify into a different component. | Only repos whose selectors used an interior `**` (e.g. `src/**/index.ts`). |
| `arch.metric` | `loc` no longer counts a phantom trailing line, so a file of exactly `max` lines correctly stops violating. | Files sitting at exactly the threshold. |

None of these self-heal via move-transfer — it requires the violation to have moved to a different
file, and these keep the same file.

### A correction preserved from an earlier draft of this document

An earlier draft of this section instructed a manual `align baseline prune` → `align check` →
`align baseline accept` sequence and justified the *order* as a correctness requirement, on the
grounds that `align check` move-transfers your real baseline while `align baseline prune` does not.
**That was wrong on both halves.** `align check` does move-transfer and persist
(`commands/check.ts`), but so did `prune` — it built its store from your real baseline and ran the
same transfer logic (`commands/baseline.ts`, `baseline/store.ts`), passing a stub graph that
`prune` then ignored. The two paths behaved identically; there was no correctness reason to run one
before the other.

That specific ordering guidance no longer applies as guidance — the manual ceremony it described is
superseded by `align upgrade`, which reconciles the baseline for you. The technical correction
itself remains true and is kept here for the record rather than deleted: `prune` and `check` never
disagreed on move-transfer, and — see "Baseline move-transfer only fires on a real move" below —
move-transfer itself was tightened in this same release, so the hazard the original (wrong) claim
was worried about does not exist under either reading.

### Component selector `**` now matches whole path segments only

An interior `**` in a component selector (e.g. `app/**/model.ts`) used to match an arbitrary
substring, crossing `/` boundaries — so `app/**/model.ts` could match `app/datamodel.ts`, a file
with no matching path-segment boundary at all. It now matches only whole path segments, the way
`**` behaves in most other glob dialects.

If a selector relied on the old cross-boundary behavior, some files may now match a different
component or none at all — a config-level change that needs your judgment, not a mechanical fix.
If a component selector now matches zero files, `align check` fails with:

```
Component 'x' (selector: ...) has zero files classified to it in this scan
```

That is the fix working — the selector was matching files it should not have. Narrow or correct the
selector. If the component is legitimately empty, set `empty: 'until-populated'` (it arms
automatically once files land) or `empty: 'allow'`.

Similarly, `**/`-leading and `{a,b}` brace patterns in `excludes` now behave the same way they
already did in component selectors — a root-level file matching `**/*.generated.ts` is now
genuinely excluded, and `{dist,build}/**` now works instead of silently matching nothing. If your
excludes relied on either being a no-op, you will see fewer violations, not more.

### `.align/version.json` provenance stamp

align now writes `.align/version.json` whenever it writes anything else under `.align/` (init,
build --apply, export-ir, baseline accept/prune, and a check that moves a baseline entry). It
records which align version last touched `.align/`, so `align check` and `align doctor` can tell
you when your artifacts were written by a different align than the one running now. Nothing to do —
this is informational only.

### Changes that need nothing from you

Worth knowing about, but no migration:

- **A corrupt `.align/baseline.json` now fails loudly** instead of being read as empty. Previously
  a merge-conflicted baseline was silently treated as "nothing accepted", and the next
  `align baseline accept` overwrote the file, destroying every entry. If you hit the new error,
  the most likely cause is an unresolved merge conflict — resolve it or restore from git.
- **`align init` and `align build --apply` refuse to rewrite a malformed align block** in
  `CLAUDE.md` or `align.config.ts` rather than guessing which content is yours. Previously an
  orphaned start marker could cause the next run to delete everything between it and the block —
  in `align.config.ts`, that meant your ruleset. If you see the new error, restore exactly one
  `<!-- align:start -->` … `<!-- align:end -->` pair, or delete both markers and let align
  re-append.
- **Config errors print cleanly and exit non-zero** instead of emitting a raw Node stack trace.
  This covers a syntax error in `align.config.ts`, a missing `default` export, a malformed
  `excludes`/`compositionRoots`/`knownPublicDeepImports` export, and a corrupt or schema-invalid
  `.align/generated-rules.json`. Schema-invalid `.align/` artifacts now name the file and list
  the offending fields instead of dumping a raw validation error.
- **`align agent run` twice in the same day works.** It used to crash on a branch-name collision;
  it now resumes onto the existing `align/fixes-<date>` branch, and refuses to continue at all
  if it cannot land on that branch.
- **`align doctor` honours your excludes the same way `align check` does.** It previously used a
  laxer matcher, so you may see fewer advisories.
- **Baseline move-transfer only fires on a real move.** Previously an orphaned entry was
  transferred onto any current violation with matching rule id + snippet in a different file —
  so fixing a violation in one file while adding a textually identical one in another, in the
  same commit, silently baselined the new one and left CI green. A transfer now requires the
  orphan's own file to have genuinely disappeared from the scan. Renames still transfer, which
  is what the mechanism exists for; `align baseline prune` was affected too and is also fixed.
- **A fix proposal listing the same file twice is rejected** rather than silently applying only
  one of the two entries' edits.

`align doctor` still always exits 0, including on a config error, which it reports as a
`config-error` advisory.
