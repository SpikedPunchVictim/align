# ADR 014: Untrusted-Repo Execution Mode (`align check --untrusted`)

**Status**: Accepted

## Context

`align check` executes repo-controlled code on every run, twice over. First, `packages/cli/src/config.ts`'s
`loadConfig` dynamically `import()`s `align.config.ts` from the target repo — not via `jiti` (there is no
`jiti`/`tsx` dependency in this codebase; Node 22+ strips TypeScript types natively on dynamic import of a
`.ts` file), but the execution surface is identical either way: whatever top-level code that file (or
anything it imports) contains runs, unsandboxed, in the align process. Second, every `custom.host` rule's
predicate — a plain JS function named in `align.config.ts`'s sibling `hostRules` export (ADR 002's amendment)
— is invoked by `evaluateCustomHost` during rule evaluation. Both are, structurally, `eval` with extra steps.

This is fine — expected, even — when a human runs `align check` in a repo they wrote or explicitly trust.
It is arbitrary code execution when align runs against a repo someone else controls. And align's own adoption
design makes that scenario not hypothetical but targeted: ADR 009's `align init` seeds a CLAUDE.md/AGENTS.md
block that tells an agent to run `align check` **unprompted** — that is the entire point of ADR 009, proven
necessary by probe 1 (ADR 001: zero unprompted align calls without it). An agent that clones an untrusted
repo and follows its own onboarding instructions (or a *poisoned* CLAUDE.md the untrusted repo ships, which
an agent has even less reason to question) will run `align check` before doing anything else — at which
point `align.config.ts` and any `hostRules` predicate in that repo execute with the agent's full permissions,
before the agent has looked at a single line of application code. The oracle designed to make an agent's
architectural judgment trustworthy becomes, on a hostile repo, the first thing that compromises the agent.

This is philosophically the sibling of ADR 013's `security.manifest` gate, not a new problem: `security.manifest`
exists because align gates *other projects'* supply-chain trust (dependency sourcing, new-dependency consent)
while, until this ADR, shipping its own unmitigated code-execution vector in the exact tool that does the
gating. Both are instances of the same discipline — an oracle that is supposed to be trustworthy cannot itself
be a trust liability — applied to two different attack surfaces (their dependency tree vs. align's own config
file).

The portable JSON IR (ADR 002, locked decision #1: `defineProject` returns `RulesetIR`, zod-parsed, no
function-valued fields anywhere in it) was designed exactly so a ruleset could be **data, not code** — evaluable
by a cache key, a baseline fingerprint, or a language plugin without ever importing TypeScript. This ADR is
where that design pays for itself: an untrusted-repo mode is possible with zero new evaluation machinery,
because the IR was already portable.

## Decision

**`align check --untrusted` (alias `--ir-only`)**: never calls `loadConfig`, never dynamically imports
`align.config.ts`, never invokes a `hostRules` predicate. The ruleset is loaded from a single committed JSON
artifact, `.align/ruleset-ir.json`, `.parse()`d through the same `rulesetIRSchema`/`exportedRulesetSchema`
zod boundary every other IR consumer uses (ADR 002's parse-don't-validate discipline). `runUntrustedCheck`
(`packages/cli/src/commands/check.ts`) is a structurally separate function from `runTrustedCheck` — not a
branch inside one function with a shared `loadConfig` call — specifically so `loadConfig` never appears in its
call graph at all, not just so it's unreachable at runtime.

**One data source, not two.** The task framing this ADR was commissioned under named two candidate sources —
a "committed IR artifact" (`.align/generated-rules.json` + a serialized components map) and a "serialized
config export" (`defineProject`'s already-portable `RulesetIR`, dumped to JSON once in a trusted context).
These turn out to be the same artifact once you look at what `RulesetIR` actually contains: `components` +
`rules`, already zod-parsed, already zero-function JSON (ADR 002). `.align/generated-rules.json` is
deliberately *not* this — it's rules-only, no `components` (ADR 011's own comment: "components stays authored
once in align.config.ts, never duplicated into the generated artifact") — so it cannot stand alone as an
untrusted-mode source; a rule referencing a component the untrusted consumer has never seen is exactly the
dangling-reference vacuous-truth class ADR 008's amendment exists to prevent. Building a second, parallel
"serialized components map" artifact just to pair with it would duplicate what `RulesetIR` already is. Instead:

- **`align export-ir [--out <path>]`** (`packages/cli/src/commands/export-ir.ts`) runs once, in a trusted
  context — it calls the *same* `loadConfig` trusted mode already uses (hand-authored rules merged with any
  `.align/generated-rules.json` doc-built rules, ADR 011's existing merge path) — and writes
  `{ irVersion, exportedAt, excludes, ruleset }` to `.align/ruleset-ir.json`. `excludes` rides along because
  it's scan-time plain-string-array data (already a documented `RulesetIR`-external deviation, ADR 002's
  `config.ts` note) that an untrusted scan still needs and that carries zero code-execution risk to include.
  `hostRules` is never included — predicate functions cannot survive a JSON boundary, full stop.
- **`align check --untrusted`** reads that file (`readRulesetIr`, `packages/cli/src/align-dir.ts`) and runs
  `GateOrchestrator.check` against it exactly as trusted mode would against a freshly-imported config —
  `GateOrchestrator` was already ruleset-agnostic (it takes a `RulesetIR` value, not a config path), so no
  core evaluation code needed to change for this to work.

**`custom.host` is unavailable under `--untrusted`, by refusal, not silent skip.** A `custom.host` predicate
is host-side code by definition (ADR 002's amendment: `HostPredicate = (ctx) => HostViolation[]`, an arbitrary
function) — there is no registry to consult under `--untrusted` because `align.config.ts`'s `hostRules` export
is never read in that mode at all. `assertNoCustomHostRules` (`packages/core/src/rules/host-rules.ts`) is a
pre-flight guard the CLI calls before constructing the orchestrator: any `custom.host` rule in the exported
ruleset throws `UntrustedCustomHostRuleError`, naming every offending rule id, before a scan even starts. This
was a choice between two options the task explicitly posed — hard error vs. skip-with-loud-advisory — and
error wins on the same doctrine ADR 008's amendment already settled for dangling references: **a silently
skipped rule reports green while enforcing nothing, which is the vacuous-green/false-green class this project
treats as severity-zero, not a UX nicety to soften.** An advisory that could be missed (truncated, unread,
buried under 200 other lines of `--json` output) is not a safe substitute for a verdict that structurally
cannot lie. The tradeoff this accepts: a ruleset with real, wanted `custom.host` rules simply cannot be fully
enforced under `--untrusted` — those rules are dropped from *coverage*, not from the verdict's honesty. That
gap is visible (the refusal names every dropped rule) and actionable (replace with a portable `arch.*`/
`security.manifest.*` kind, or accept reduced untrusted-mode coverage for that specific rule).

**Refuse, never fall back, when the artifact is missing or unreadable.** No `.align/ruleset-ir.json` under
`--untrusted` is not a fallback-to-trusted-execution scenario — it is fatal, with a message naming both
remedies (`align export-ir` in a trusted checkout, or drop `--untrusted` only on a repo you already trust to
execute code). A corrupted or hand-mangled artifact (invalid JSON, schema-invalid) is treated identically to
missing, not to "zero rules" — `readRulesetIr` throws rather than returning `undefined`, exactly mirroring
`readGeneratedRules`'s existing "a corrupted build artifact is never silently treated as absent" discipline.
Any of these three (missing / corrupted / schema-invalid) failing open to "run align.config.ts instead, just
this once" would silently reintroduce the exact vulnerability this ADR exists to close, at precisely the
moment (a missing or tampered artifact) an attacker is most likely to have engineered.

**Scanner audit: confirmed no repo-code execution path.** The concern this ADR's commissioning brief raised —
does TypeScript module resolution or the scanner itself ever `require`/dynamically `import` a repo file — was
audited directly: `grep -rn "require(\|import(\|eval(" packages/plugin-typescript/src` finds exactly one hit,
a comment in `exports.ts` describing the AST walk that *detects* `import()`/`require()` **syntax** in scanned
source (to build the dependency graph), never an actual dynamic-import/require *call* on the scanner's own
part. `ts.resolveModuleName` (used by `tsconfig-resolver.ts`) resolves specifiers to paths at the type-checker
level; it does not execute the resolved file. The TypeScript scanner reads and parses repo source as text via
the compiler API — the same "reading data" category as `ManifestScanner`'s `package.json`/`pnpm-lock.yaml`
text reads (ADR 013) — and this holds regardless of `--untrusted`, because it was already true in trusted
mode. `--untrusted` closes the two execution paths that exist (config import, host predicates); it does not
need to additionally sandbox the scanner because the scanner was never a code-execution path.

**Trusted mode is unchanged.** `runTrustedCheck` is `runCheck`'s pre-existing body, extracted, not rewritten —
every existing flag (`--json`, `--frozen-rules`, generated-rules summary) behaves identically. `--untrusted`
and `--frozen-rules` together is a guarded, explicit error (frozen-rules drift detection reads the live
`align.config.ts`/`.align/generated-rules.json`/`.align/rules.lock.json` trio, which is exactly the trusted-mode
filesystem state `--untrusted`'s committed-artifact-only contract excludes) — refused up front rather than
producing an inconsistent or silently-wrong combination.

## Alternatives considered

- **Sandbox the config import** (a `vm2`/isolated-`vm`/worker-thread boundary around `loadConfig`). Rejected:
  none of Node's built-in sandboxing primitives are a real security boundary against a determined attacker
  (`vm2`'s own maintainers have shipped and disclosed sandbox-escape CVEs; Node's `vm` module is explicitly
  documented as *not* a security mechanism). Building or depending on a "mostly safe" sandbox would trade a
  known, auditable code-execution vector for an unknown, false sense of one — worse, not better, for the exact
  threat model this ADR is scoped to (an adversarial repo, not an accidentally-buggy one).
- **Static-only config parsing** (parse `align.config.ts` as an AST and extract the `defineProject(...)` call's
  arguments without executing anything). Rejected: `align.config.ts` is arbitrary, Turing-complete TypeScript
  by design (ADR 002 — a typed, autocompleting SDK, not a stringly-typed format); a static parser would have to
  either refuse any config using a loop, a conditional, a helper function, or a computed component name (which
  would break real, legitimate configs and become an ever-growing allowlist of "parseable subset" TypeScript),
  or silently produce a wrong/partial ruleset for anything outside that subset — a false-green risk this
  project's own doctrine forbids. `RulesetIR` already exists as the correct static representation; re-deriving
  a weaker one via AST parsing duplicates it with strictly worse coverage.
- **A separate "serialized components map" artifact alongside `.align/generated-rules.json`**, as originally
  posed. Rejected once `RulesetIR`'s actual shape was checked: it is already `components + rules` in one
  portable value, so a second artifact would either duplicate `RulesetIR` under a different name or force
  `.align/generated-rules.json` (deliberately components-free, ADR 011) to grow a field it was explicitly
  designed not to carry.

## Consequences

- **Residual, honest, not closed**: the scanner still reads (parses, never executes) every source file in the
  repo — a maliciously crafted file *could* still exploit a bug in the TypeScript compiler's own parser, which
  is outside align's threat model to close (align does not, and cannot, audit `typescript`'s own parser
  security). This is the same category of residual risk `security.manifest`'s manifest-text reads accept
  (ADR 013) — reading untrusted data is not risk-free, only categorically safer than executing it.
- **Trusted mode remains the default** — `--untrusted` is opt-in, not the new baseline. An agent following
  ADR 009's CLAUDE.md instructions on a repo it has not been told is untrusted will still run trusted
  `align check` today; closing that gap (e.g. CLAUDE.md language that tells an agent *when* to reach for
  `--untrusted`, or a repo-provenance signal that triggers it automatically) is a follow-up, not built here.
- **README warning, flagged for the README-owning agent (not written here — out of this ADR's file territory)**:
  suggested verbatim text —

  > **Security note**: `align check` executes `align.config.ts` and any `custom.host` predicates it
  > registers — do not run it against a repository whose config you have not reviewed. Cloning an untrusted
  > repo and running an agent against it? Run `align check --untrusted` instead (after `align export-ir` has
  > produced `.align/ruleset-ir.json` in a trusted checkout) — it never imports `align.config.ts` and refuses
  > outright if that JSON artifact is missing. See `docs/adr/014-untrusted-config-execution.md`.

- **`custom.host` rules need a portable replacement to be enforced under `--untrusted`** — repos that rely on
  them for real enforcement (not just Design Reserve exercise) should treat this as a prompt to promote the
  underlying check to a first-class `arch.*`/`security.manifest.*` kind if it's general enough, the same
  promotion-on-evidence doctrine ADR 013 already used for two of the manifest probe's seven candidates.
- Every future rule kind or config-adjacent artifact must ask the question this ADR asks: does evaluating it
  require executing anything the repo controls? If yes, it needs its own `--untrusted` story before it ships,
  the same way every future rule kind extending the reference-validity switch (ADR 008's amendment) is already
  a compiler-enforced obligation, not a checklist item someone can forget.

## Evidence

No spike measurement (this is a security-hardening ADR, not a rule-kind promotion) — the design is derived
directly from the DSL/IR contract ADR 002 already locked (`RulesetIR` is portable JSON by construction) and
validated by the test suite added alongside this ADR: `packages/cli/test/untrusted.test.ts`'s decisive case
exports the IR from a working `align.config.ts`, then overwrites that same file with one that throws — trusted
`align check` rejects on it (sanity check, run against a directory whose config was never previously imported
in-process, to avoid Node's ESM import-cache-by-URL masking the edit), while `align check --untrusted` against
the identical poisoned directory stays green, because its call graph never reaches the import. A second test
proves the same property via a side effect instead of an error: a config that writes a sentinel file on import
leaves no sentinel on disk after `--untrusted` runs. `packages/core/test/rules/host-rules.test.ts` covers
`assertNoCustomHostRules`/`UntrustedCustomHostRuleError` directly.
