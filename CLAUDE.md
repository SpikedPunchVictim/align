<!-- align:start -->
## align — architecture conformance

This repo is checked by [align](https://github.com/SpikedPunchVictim/align) for dependency-direction and import-cycle
conformance. Run `align check` (or the `align_check` MCP tool if the align MCP server is
connected) after any structural code change — new imports, moved files, restructured modules.

**A red `align check` is blocking.** Do not consider a structural change complete while
`align check` reports red. Run `align explain <ruleId>` (or the `align_explain_rule` MCP tool)
to understand why a rule fired before proposing a fix.

For full rule-authoring guidance run `align skill --topic authoring`.
<!-- align:end -->

## Destructive safety — required for every feature that writes

align writes into repositories it does not own, so a defect here damages a developer's working
tree rather than returning a wrong answer. This has happened: `align init` deleted a user's
ruleset from `align.config.ts` (BUG #10), and `prune`/`init` deleted accepted baselines twice
(BUG #18, ADR 023 and its amendment). Every one was found by a human reading code, never by a
failing test.

**These rules are not optional, and they apply to new work by default:**

1. **Declare the write-set.** ADR 026: a command may create, modify, or delete only the paths its
   scenario declares; every other path must be byte-identical afterward. New scenarios default to
   the empty write-set (nothing may change), so a new command or flag fails until its author
   states what it is licensed to touch. Do not widen a write-set to make a test pass without
   understanding why the command is writing there.
2. **A new command or flag is not complete without an integration scenario** (ADR 025). If you
   added a flag and did not add or extend a scenario, the feature is unfinished.
3. **`align.config.ts` and `CLAUDE.md` are shared with the human.** align owns only the region
   between its markers. Any writer touching those files must leave the outside byte-identical —
   that is the exact property BUG #10 violated, and it is asserted, not assumed.
4. **A destructive mutation computed from a `CheckRun` must pass ADR 023's guards** —
   `refuseIfRunErrored` (tier 1, no override) and `refuseIfRunIncomplete` (tier 2,
   `--allow-incomplete`). A new destructive consumer that does not call them is a defect by
   definition. Add-only and transfer-only consumers are exempt, but the exemption must be pinned
   by a test.
5. **Never treat a doc comment asserting a safety property as evidence.** It is a claim to verify.
   Three separate times in four days this repo shipped a comment describing a guarantee nothing
   implemented.
6. **"Reports success wrongly" outranks everything.** A command that destroys data and exits 0 is
   the project's severity-zero class. When you find one, hunt the class, not the instance.

### Verifying a change

```
pnpm build && pnpm typecheck && pnpm test      # ~26s, 1104 tests — the fast gate, run it always
node packages/cli/dist/index.js check          # must be green; red is blocking
node packages/cli/dist/index.js doctor         # advisory only, always exits 0
node integration/run.mjs --targets local       # Docker; real project, real command sequences
```

The full cross-version matrix (`--targets 0.1.4,local`) is a release gate — three scenarios carry
`expectFailOn: ['0.1.4']` as its calibration, and if those ever pass against 0.1.4 the harness has
stopped working and nothing it reports can be trusted.
