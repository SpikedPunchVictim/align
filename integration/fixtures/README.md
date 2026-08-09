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

This directory is reserved for a future increment that genuinely needs a fixed, hand-curated
config independent of `align init`'s output — for example, a scenario asserting on a SPECIFIC
layering ruleset (not just "whatever `align init` would suggest today") to test `align check
--frozen-rules` or `align build` against doc-authored rules (ADR 025 §7's `build`/`export-ir`
rows, out of scope for increment 1).
