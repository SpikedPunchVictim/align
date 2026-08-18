# ADR 024: The MCP Baseline-Acceptance Gate Must Exist

**Status**: Accepted

## Context

ADR 006 decided the consent doctrine for the baseline, and one clause of it is specific enough to
be checkable:

> **MCP never self-serves baseline acceptance by default**: `align_baseline_accept` is gated
> behind an `allowBaselineFromMcp` flag, **default false**. An agent cannot grant itself amnesty
> from a rule it's failing — baseline acceptance is a human decision surfaced through the CLI/init
> flow, not a tool call an agent can reach for under pressure to turn red green.
> — `docs/adr/006-2026-07-11-baseline.md:40-43`

**`allowBaselineFromMcp` does not exist in the implementation.** A repo-wide search finds it in
exactly three places, all of them prose:

| Location | What it is |
|---|---|
| `docs/adr/006-2026-07-11-baseline.md:41` | the decision itself |
| `packages/cli/src/docs/conceptual.ts:26` | user-facing docs, printed by `align docs` |
| `packages/cli/src/skill/static-sections.ts:70-71` | **the skill align installs into the agent's instructions** |

There is no flag, no config key, no check. The named tool `align_baseline_accept` was never
registered either (`mcp/server.ts` registers `align_check`, `align_violations`,
`align_explain_rule`, `align_propose_rules`), so the gate never had a subject and its absence went
unnoticed.

Meanwhile a different MCP path does write to the baseline, ungated. `align_propose_rules` accepts
`accept_new_into_baseline`, which flows directly to `writeBuildArtifacts(rootDir, result,
{ acceptNewIntoBaseline: accept_new_into_baseline === true })` (`mcp/server.ts:241`) and reaches
`store.accept(result.impact.addedNew, 'manual')` + `writeBaseline` (`commands/build.ts:269-273`).
No flag is consulted at any point.

So align ships a document telling agents a protection exists, and ships a path that does the
thing the protection describes preventing. **The false claim is the more serious half.** An
unprotected capability is a gap; a *documented* protection that does not exist is worse, because
it stops anyone from looking — and align's own installed skill is what tells the agent it is safe.
For a conformance tool, a divergence between stated doctrine and actual behaviour is the
least acceptable place to have one.

**The honest mitigating fact**, stated because the fix should not be sold as bigger than it is:
`accept_new_into_baseline` is materially narrower than the `align_baseline_accept` ADR 006
imagined. It accepts only `result.impact.addedNew` — violations newly introduced *by the rules
being proposed in that same call* — not arbitrary existing reds. An agent cannot use it to clear a
pre-existing failure it is stuck on, which is the specific scenario ADR 006's rationale describes
("under pressure to turn red green"). Baselining a new rule's pre-existing debt at adoption time
is a legitimate workflow; it is exactly what `align baseline accept --rule <ruleId>` exists for
(ADR 006:29-32). The defect is that it happens **over MCP, ungated, while the docs promise a
gate** — not that the capability is inherently illegitimate.

## Decision

**Implement `allowBaselineFromMcp` as the single gate on every MCP path that writes to
`.align/baseline.json`, default `false`.** This is not a new decision; it is bringing the code to
a decision ADR 006 already made and shipped documentation for.

1. **One gate, all paths.** The flag governs any MCP-reachable baseline write, present or future —
   today that is `align_propose_rules`'s `accept_new_into_baseline`. It is not scoped to a tool
   name, because scoping to `align_baseline_accept` by name is precisely how this was missed.
2. **Default `false`,** as ADR 006 specifies. With the flag off, `accept_new_into_baseline: true`
   is refused with an actionable message naming the CLI equivalent
   (`align baseline accept --rule <ruleId>`), not silently ignored — a silently-dropped parameter
   would leave the agent believing debt was accepted when it was not.
3. **Opt-in lives in `align.config.ts`,** following the existing config-export pattern
   (`excludes`, `compositionRoots`, `knownPublicDeepImports`, `telemetry`). A human edits the
   repo's config to grant it; an agent cannot enable it through any MCP tool.
4. **`apply: true` without `accept_new_into_baseline` is unaffected.** Writing
   `generated-rules.json` / `rules.lock.json` is rule authoring, not consent to debt, and ADR 011
   governs it. This ADR touches only the baseline write.
5. **Correct the prose in the same change.** `skill/static-sections.ts:70-71` and
   `docs/conceptual.ts:26` currently name a tool that does not exist (`align_baseline_accept`).
   They must describe the real surface: the gate, its default, and the tool it actually governs.
   Shipping the gate without fixing the text would leave the agent-facing claim wrong in a new way.

## Alternatives considered

**Correct the documentation to match the code — no gate.** Rejected. It resolves the
inconsistency in the wrong direction: ADR 006's reasoning is sound and was never withdrawn, and
the reasoning applies to any MCP baseline write regardless of which tool carries it. It would also
mean align's installed skill tells agents there is no restraint here, which is worse guidance than
the false claim it replaces.

**Remove `accept_new_into_baseline` entirely.** Rejected as disproportionate. The capability has a
legitimate adoption workflow behind it (adopt a rule, baseline its pre-existing debt) and is
narrowly scoped to the proposing call's own new violations. Default-off preserves the workflow for
projects that deliberately want it and removes it for everyone who has not thought about it —
which is the ADR 006 doctrine working as designed.

**Gate it behind a prompt/consent round-trip instead of a config flag.** Rejected: MCP has no
reliable human-in-the-loop channel, and a consent prompt an agent can answer is not consent. A
config file a human edits is the available human signal.

**Treat this as a bug and fix it without an ADR.** Rejected because the false-documentation half
is a doctrine failure, not a code failure — the repeatable lesson ("a doctrine clause naming a
specific identifier must be enforced by something that fails when the identifier is absent") is
not expressible in a patch.

## Consequences

- **Breaking for any MCP client currently passing `accept_new_into_baseline: true`** — it stops
  working until a human adds the flag to `align.config.ts`. Given the parameter is undocumented
  outside the tool description and the protection was advertised as existing, any existing
  reliance on it was reliance on a documented-away behaviour.
- The agent-facing skill and `align docs` stop making a false safety claim. This is the primary
  deliverable, not a side effect.
- A future MCP tool that writes to the baseline must consult the same flag. Because the gate is
  defined over the *capability* rather than a tool name, a new tool that skips it is a reviewable
  defect — the same structure ADR 023 uses for destructive mutation.
- ADR 006 needs no amendment; its decision stands and is now implemented. This ADR records why it
  was unimplemented for so long.

## Evidence

- `allowBaselineFromMcp` appears in exactly three files, all prose (search across `packages/*/src`,
  `packages/*/test`, `docs/` — 2026-08-08). No implementation, no test, no config key.
- `align_baseline_accept` is not registered; `mcp/server.ts` registers `align_check` (`:65`),
  `align_violations` (`:94`), `align_explain_rule` (`:124`), `align_propose_rules` (`:151`).
- The ungated write path: `mcp/server.ts:241` → `commands/build.ts:269-273`
  (`store.accept(result.impact.addedNew, 'manual')`, `writeBaseline`).
- Scope of the capability: `result.impact.addedNew` only — verified against
  `commands/build.ts:269` and the `impact` payload assembled at `mcp/server.ts:229`.
- Found by adversarial review of ADRs 021–023 (2026-08-08), as a challenge to ADR 022's claim that
  no MCP baseline-mutation path existed. That claim was false, and ADR 022 was corrected to reject
  an MCP `align_upgrade` on blast-radius grounds instead.
- Related: ADR 006 (consent doctrine), ADR 011 (`build --apply` pipeline), ADR 023 (capability-
  defined guards over tool-name-defined ones).
