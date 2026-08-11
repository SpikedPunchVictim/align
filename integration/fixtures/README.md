# fixtures/

Empty in increment 1, deliberately.

ADR 025's sketch layout lists `fixtures/` as holding "the align.config.ts authored for nest, and
any variants." Increment 1's four scenarios never need a hand-authored, checked-in
`align.config.ts` for nest: every scenario starts by actually running `align init
--accept-existing` against the real pinned checkout and derives its config from that live run,
then applies named mutations (`lib/mutations.mjs`) on top. This is more thorough than a static
fixture would be — it exercises `init`'s own component-detection logic every run (which IS one of
increment 1's four scenarios) instead of asserting against a snapshot that would silently go stale
the moment nest's package layout changes or `detectComponents`'s heuristics change — and it means
one less artifact to keep in sync with the pinned commit.

Still empty after increment 2, for the same reason. `build-dry-run-apply-verify-drift.mjs` and
`export-ir-then-check-untrusted.mjs` (increment 2) exercise `align check --frozen-rules`/
`align build`/`align export-ir` against doc-authored rules — the case this file used to reserve
this directory for — but they get there with a named mutation
(`write-architecture-rules-doc-with-fenced-rule`, `lib/mutations.mjs`) writing a real
`docs/ARCHITECTURE-RULES.md` into the live `align init` output, same discipline as every other
scenario. This directory remains reserved for a future increment that genuinely needs a fixed,
hand-curated `align.config.ts` independent of what `align init` would derive live.
