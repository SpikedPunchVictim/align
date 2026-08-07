# Upgrading align

## Unreleased — next release after 0.1.4

This release fixes 15 bugs found in a full-codebase audit. Most need nothing from you.
**Four of them change violation fingerprints**, which means some entries in your
`.align/baseline.json` stop matching and reappear as new violations. This page tells you
what to do about that, and in what order.

### Do this once, in this order

```bash
git status                 # commit or stash first — .align/baseline.json will change
align baseline prune       # STEP 1 — must come before any `align check`
align check                # STEP 2 — review what is now red
align baseline accept      # STEP 3 — only after you have reviewed step 2
```

#### Why `prune` must come first

This is not stylistic; running `align check` first can silently accept a real violation.

`align check` runs baseline move-transfer against your real baseline and **writes the result
to disk** (`commands/check.ts` — the orchestrator is constructed with your loaded baseline,
and `persistMovedBaseline` saves any transfers). Move-transfer matches an orphaned entry to a
current violation by rule id + snippet, in a different file.

`align baseline prune` and `align baseline accept` construct their orchestrator with an
**empty** baseline (`commands/baseline.ts`), so they never move-transfer your real entries.

Because this release deliberately orphans entries, letting `check` run first gives
move-transfer a pool of orphans to mis-match. The most likely victim is `arch.metric`, whose
snippet is just the file's first line — two over-long files sharing a license header or a
common import collide trivially, so an orphan can transfer onto an unrelated file and
silently baseline a genuine violation. `prune` deletes the orphans outright instead.

#### Why you should review before `accept`

After `prune`, the re-fingerprinted violations come back as new. `align baseline accept` with
no arguments accepts **everything currently red**, which includes any genuinely new debt
introduced since your last run. Read `align check`'s output first, or scope the accept with
`--rule <ruleId>`.

---

### What changed fingerprints

| Rule kind | Why it changed | Scale |
|---|---|---|
| `arch.no-cycles` | The reported cycle is now derived by BFS instead of a greedy walk that could return a path which was not a cycle at all. | Measured across six real repos: **~4%** of multi-node SCCs were reporting a phantom chain and are corrected; another **~1.4%** get a shorter, genuine cycle. |
| `custom.host` | The violation's line number is no longer folded into its fingerprint, so a predicate finding survives reformatting. | Every baselined `custom.host` entry. |
| `arch.no-dependency`, `arch.layers` | `**` in a component selector now matches whole path segments only, so files may reclassify into a different component. | Only repos whose selectors used an interior `**` (e.g. `src/**/index.ts`). |
| `arch.metric` | `loc` no longer counts a phantom trailing line, so a file of exactly `max` lines correctly stops violating. | Files sitting at exactly the threshold. |

None of these self-heal via move-transfer — it requires the violation to have moved to a
different file, and these keep the same file. `prune` + `accept` is the only path.

### One error you may hit right after upgrading

If a component selector relied on `**` crossing path segments, it may now match zero files,
and `align check` will fail with:

```
Component 'x' (selector: ...) has zero files classified to it in this scan
```

That is the fix working — the selector was matching files it shouldn't have. Narrow or correct
the selector. If the component is legitimately empty, set `empty: 'until-populated'` (it arms
automatically once files land) or `empty: 'allow'`.

Similarly, `**/`-leading and `{a,b}` brace patterns in `excludes` now behave the same way they
already did in component selectors — a root-level file matching `**/*.generated.ts` is now
genuinely excluded, and `{dist,build}/**` now works instead of silently matching nothing. If
your excludes relied on either being a no-op, you will see fewer violations, not more.

---

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
- **A fix proposal listing the same file twice is rejected** rather than silently applying only
  one of the two entries' edits.

`align doctor` still always exits 0, including on a config error, which it reports as a
`config-error` advisory.

---

### If you have no baseline

Nothing to do. Run `align check` as usual.

### If `align check` was already red

Fix or accept as you normally would; the procedure above is only about preserving debt you had
already accepted.
