---
name: bug-hunt
description: 'Hunt for semantically fragile code that pattern-based auditors miss. 9 analysis lenses: assumptions, state machines, boundaries, data lifecycle, error paths, time & concurrency, environment divergence, cross-implementation divergence, and write/read asymmetry. Language-agnostic core with per-language accelerator packs. Every finding must survive an adversarial refutation pass; every proposed fix must pass a defect checklist before it is reported. Triggers: "bug hunt", "hunt for bugs", "find hidden bugs", "assumption audit", "what could go wrong".'
version: 1.0.0
license: Apache-2.0
allowed-tools: [Grep, Glob, Read, Write, Bash, AskUserQuestion, Agent]
metadata:
  tier: analysis
  category: debugging
---

# Bug Hunt

> **Quick Ref:** Find bugs by analyzing *intent*, not syntax — then try to kill your own findings, and verify your own fixes. Output: `.agents/research/YYYY-MM-DD-bug-hunt-<scope>.md`

**YOU MUST EXECUTE THIS WORKFLOW. Do not just describe it.**

**Philosophy:** There are two gaps in every audit. The *finding gap*: "the code compiles" vs "the code handles every real scenario." And the *fix gap*: "this patch addresses the finding" vs "this patch is itself correct." A wrong finding wastes an hour of someone's review time. A defective fix ships a new bug with an auditor's stamp of approval on it — strictly worse than no fix. This skill closes both gaps: findings pass an adversarial refutation step (Step 5), fixes pass a defect checklist (Step 6). Nothing reaches the report unverified.

## Non-Negotiable Rules

1. **Freshness.** Base all findings on current source only. Never read `.agents/`, `scratch/`, prior audit reports, or cached memory of this codebase. Every claim comes from a file read in this session.
2. **Full reads.** Never classify from a grep match. Read the whole enclosing function, plus at least 30 lines of context, plus any enclosing conditional-compilation or feature-flag block.
3. **Negative-claim discipline.** Any claim of absence — "no validation exists", "X is never checked", "there is no guard" — must cite its search receipt: the exact grep patterns run and the directories they covered, which MUST include the guard map (Step 2). If you did not search the guard map, you may only write "I did not find X in [places actually searched]" — never "X does not exist." Absence claims are the most frequently refuted claims in any audit.
4. **Every BUG/FRAGILE survives Step 5 refutation** before it is written to the report.
5. **Every suggested fix passes the Step 6 checklist** before it is written to the report.
6. **Every finding carries a Confidence label:** `Confirmed (empirical)` — demonstrated by running code; `Traced` — mechanism verified clause-by-clause against source; `Suspected` — plausible but not fully traced. `Suspected` findings go in Needs Review, not in the BUG list.

---

## Pre-flight: Git Safety Check

```bash
git status --short
```

If uncommitted changes exist, ask:

```
AskUserQuestion: "You have uncommitted changes. Commit before proceeding?"
Options: "Commit first (Recommended)" / "Continue without committing"
```

If "Commit first": ask for a message, stage, commit, then proceed.

---

## Step 0: Detect the Stack, Load the Right Accelerator Pack

The lenses are language-agnostic. The grep accelerators are not — load only the pack(s) for the languages actually present.

**0.1 — Detect languages:**

```bash
git ls-files | sed -n 's/.*\.\([a-zA-Z0-9]*\)$/\1/p' | sort | uniq -c | sort -rn | head -15
```

**0.2 — Load pack(s)** from `references/` for every language with a meaningful footprint:

| Extensions | Pack |
|---|---|
| ts, tsx, js, jsx, mjs, cjs | `references/accelerators-typescript.md` |
| py | `references/accelerators-python.md` |
| go | `references/accelerators-go.md` |
| swift | `references/accelerators-swift.md` |
| java, kt, kts | `references/accelerators-jvm.md` |
| rs | `references/accelerators-rust.md` |

**0.3 — Always additionally load `references/accelerators-sql.md`** if the repo contains a migrations directory, `.sql` files, or an ORM schema (`schema.prisma`, `*.dbml`, kysely/knex/alembic/flyway migrations). Schema files decide whether findings are real — they are consulted in Steps 2, 4, and 5, not just here.

**0.4 — Establish runtime context.** Ask:

```
AskUserQuestion: "What runtimes/environments does this project ship to?"
Header: "Runtime"
Options (multiSelect): "Server (Node/JVM/Go/etc.)" / "Browser" / "Mobile (iOS/Android)" /
  "Desktop" / "Other — I'll describe (containers, serverless, embedded, OS versions)"
```

Record the answer plus any directories the user identifies as dead, generated, or vendored. Every lens must honor it: code compiled out or unreachable in every shipping runtime is OK, not BUG. Code that is live in *one* shipping runtime is live.

---

## Step 1: Choose Scope and Lenses

**1.1 — Scope.** Ask:

```
AskUserQuestion: "What should I hunt?"
Options: "Specific file or feature" / "Recently changed files (last 5 commits)" / "Full codebase"
```

- **Recently changed:** `git diff --name-only HEAD~5 | grep -Ev '(^|/)(test|tests|spec|__tests__|fixtures)/|\.(md|json|lock|snap)$'`
- **Full codebase:** inventory with Glob, then prioritize by consequence, not by size:
  1. Crypto, auth, money, and identity paths (highest consequence per line)
  2. Data layer — persistence, sync, deletion, migration application
  3. Business logic — state managers, services, workflow orchestration
  4. Complex input handling — parsers, normalizers, protocol boundaries
  5. Skip: generated code, tests, pure presentation, vendored deps

**1.2 — Lenses.** Ask:

```
AskUserQuestion: "Which lenses?"
Options: "All 9 (Recommended)" / "Quick 4 — Assumptions + Boundaries + Error Paths + Write/Read Asymmetry" / "Let me pick"
```

---

## Step 2: Build the Guard Map (Before Hunting)

**Guards almost never live next to the line they protect.** A unique constraint in a migration refutes a duplicate-row finding; a validator module inverts a mechanism; a middleware makes an "unauthenticated" finding false. Before any lens runs, locate and record the paths of:

| Guard location | How to find it |
|---|---|
| DB migrations / DDL | `Glob **/migrations/**`, `**/*.sql`, `schema.prisma`, `*.dbml` |
| API / input schemas | Grep for `openapi`, `zod`, `joi`, `yup`, `ajv`, `pydantic`, `protobuf`, JSON Schema files |
| Validation modules | `Glob **/*{alid,anitiz,checker}*` and grep `validate\|sanitize\|normalize` in lib/util dirs |
| Middleware / interceptors / guards | Framework hook dirs: `middleware`, `guards`, `interceptors`, `hooks`, `plugins`, decorators |
| Config defaults & limits | Files named `Default*`, `Config*`, `constants`, env-schema definitions |
| Shared constants / branded types | Central type/constant modules the flagged code imports |
| Sibling implementations | Other implementors of the same interface / other backends of the same store |
| Tests | Existing tests may assert that the "buggy" behavior is intended |

Write the resulting file list into the report's **Guard Map** section. Steps 4 and 5 grep *these files* — not just the flagged file's neighborhood — before any finding is confirmed and before any absence claim is made.

---

## Step 3: Execute Lenses

For each in-scope file: read it fully, then apply each selected lens. Accelerator greps (from the loaded pack) only generate *candidates* — classification happens in Step 4.

### Lens 1: Assumption Audit
List every implicit assumption per function: "this collection is non-empty", "this key exists", "this string is in format X", "the caller already normalized this", "this external call completes before teardown", "this enum never grows." For each: violation likelihood (Never/Rare/Occasional/Common), consequence (Crash / Silent data loss / Wrong result / Graceful), guard present? Candidate if likelihood ≥ Rare, consequence ≥ Wrong result, no guard.

### Lens 2: State Machine Analysis
Any mutable status — UI flags, DB status columns, job/workflow states, session states. Map transitions: dead-end states (entered, never exited), mutually-exclusive states that can be simultaneously true, transitions interrupted mid-way (process crash, request abort, task cancellation, user navigation), and reset paths — after an error or cancellation, does state return to something usable?

### Lens 3: Boundary Conditions
For every conditional and every size-dependent operation: zero / one / maximum / negative / just-past-a-threshold. Empty collections and strings; index arithmetic (`len - 1`, negative offsets); fixed-width reads on variable-width data; platform limits (stack size for spreads/recursion, max argument counts, buffer sizes); Unicode (non-Latin scripts, combining chars, RTL); values that survive one check but fail a *stricter* downstream check (a 1-char value passes an `!== ""` guard but fails a 2-char minimum — check the real constraint, not the assumed one).

### Lens 4: Data Lifecycle Tracing
Follow each primary entity: creation (validated where?), modification (conflicts? partial writes?), persistence (can a save fail silently? multi-statement writes without a transaction?), display (stale reads?), deletion (cascades? orphans? pattern-matching deletes that over-match?), sync (conflict policy?). Flag: created-but-never-persisted, deleted-with-references-remaining, non-atomic multi-step mutations, over-broad delete predicates.

### Lens 5: Error Path Exerciser
For every catch/except/recover, optional chain, fallback, and async boundary: is the error surfaced or swallowed? Is state consistent after the error path? Can the user/caller retry? Does the async error actually route to the handler (promise vs callback vs event-emitter APIs — a `try/catch` around a callback-style call catches nothing)? Empty catch blocks; catches that log but don't recover; "loading forever" traps; fire-and-forget tasks whose errors vanish; error branches that are dead code because their condition can't occur.

### Lens 6: Time & Concurrency
Timezone/locale-dependent parsing and folding; expiry without an expiry check; rapid repeats (double-submit, duplicate records); check-then-act races (TOCTOU: `exists()` then `insert()` with nothing reserving the name in between); rate-limit and dedupe keys that don't survive input variation; slow/absent network; retries without idempotency.

### Lens 7: Environment Divergence
Behavior that varies by runtime version, OS, container image, host locale/ICU, hardware, env var, or feature flag — where one variant is clearly less tested. Version-gated code with an incomplete fallback branch. Configuration that changes semantics between deploys ("works in every region we've deployed to *so far*").

### Lens 8: Cross-Implementation Divergence *(new — highest yield per hour)*
**Same invariant, two implementations, one guards.**
1. List invariants implemented in more than one place: multiple backends of one store interface, SDK vs server, client vs server validation, two services sharing a protocol, a v1 and v2 of anything.
2. For each invariant, build a guard matrix: implementation × "guard present at file:line / absent".
3. Any row where one implementation guards and another does not is a finding candidate — the unguarded one is presumed wrong until design evidence says otherwise. The guarded sibling is your specification: cite it.

### Lens 9: Write/Read Path Asymmetry *(new)*
**A value normalized on one side of storage but not the other.**
1. Inventory every canonicalization applied to a stored/keyed field: case folding, trim, Unicode normalize, encoding, hashing.
2. For each field, grep **every write site** (insert/update/save/serialize) and **every read site** (query/lookup/deserialize/compare). Asymmetry on any pair is a candidate.
3. Include derived keys: cache keys, rate-limit keys, dedupe keys, filenames built from the field must use the identical normalization as storage — a limiter keyed on the raw value while storage is normalized is this bug.
4. When you find one instance, sweep the class: the same store usually has siblings.

---

## Step 4: Verify Each Finding

Before classifying ANY candidate:

1. **Read** the whole enclosing function + ≥30 lines context + any enclosing conditional block.
2. **Grep the guard map** (Step 2 file list) for the field, function, column, or constant involved. A guard found anywhere counts.
3. **Check intentional design** — comments, docs, tests that assert the behavior.
4. **Check reachability** — find at least one concrete caller path that reaches the flagged line with the violating input. No path found = REVIEW, not BUG.
5. **Assess realism** — a real user/operator/attacker on a shipping runtime must be able to trigger it.
6. **Run the cheap empirical test** when one exists. Any finding about a threshold, parser, arithmetic, regex, or library behavior almost always admits a ≤10-line check (`node -e`, `python -c`, `psql -c`, `go run` — harness snippets are in each accelerator pack). Run it in the scratchpad, record the exact command and output in the finding. Ten seconds of execution converts theory into `Confirmed (empirical)` — or kills the finding. If a cheap test exists and you skip it, the finding's Confidence caps at `Suspected`.
7. **Honor runtime context** (Step 0.4) — dead in every shipping runtime = OK.
8. **Measure blast radius** on three axes (all three go in the report):
   - **Code:** files the fix touches (grep callers/references).
   - **Data:** none / migration required / migration with collision or bad-rows risk. Ask explicitly: *can records already exist that violate the fixed invariant?* If yes, the fix is not complete without a migration and a collision plan.
   - **Coordination:** single service / multi-service or client+server lockstep / API contract change.
9. **Classify:** **BUG** (real risk, no guard, realistic, reachable) / **FRAGILE** (correct today, breaks under a foreseeable change — name the change) / **OK** (guarded, intentional, or dead) / **REVIEW** (needs human judgment) — plus the Confidence label.

---

## Step 5: Adversarial Refutation (Mandatory — no finding skips this)

You are now the opposing counsel. For **each** BUG and FRAGILE finding, actively try to kill it:

1. **Fresh re-read.** Re-open the primary evidence lines (not from memory of your earlier pass). State the mechanism in one sentence, then confirm each clause of that sentence against the source. A finding whose *conclusion* is right but whose *mechanism* is wrong is still a defective finding.
2. **Guard-map sweep.** Grep the guard map for a guard you haven't seen yet: the exact column name in every migration, the field name in every validator and schema, the route in every middleware. This is where refutations come from.
3. **Innocent explanation.** Construct the strongest case that the code is intentional: what design would make this correct? Does any test or sibling caller *rely* on the current behavior?
4. **Constraint check.** Every numeric or emptiness claim in the finding ("no minimum", "unbounded", "can be empty") gets checked against the authoritative constraint source — cite file:line of the constraint or its verified absence (per rule 3, with search receipt).
5. **Empirical kill shot.** If a cheap test could disprove the finding, run it.

Then label every sub-claim of the finding **Confirmed / Refuted / Unverified**:
- Delete Refuted sub-claims (and record them in the report's Refutation Log — killed findings are evidence of rigor, not waste).
- If the *central mechanism* is Unverified, downgrade the finding to REVIEW.
- Correct severity if the surviving mechanism differs from the original claim (a "data corruption" that is actually a "hard login failure" is still reportable — at its true severity, with its true mechanism).

---

## Step 6: Draft Fixes — Then Verify Them (Mandatory)

**Read `references/fix-verification.md` before writing any fix.** It contains the failure cases this checklist exists to prevent.

A suggested fix is code you are asking someone to ship. It gets the same scrutiny as the bug. For **every** suggested fix, complete all eight checks:

1. **Boundary-test the fix's own arithmetic.** For every length, index, offset, or size computation the fix introduces, evaluate it by hand (or empirically) at: 0, 1, boundary−1, boundary, boundary+1, and at least one input *larger than any fixed width the fix assumes*. Negative offsets into buffer/array reads and fixed-width reads on variable-width input are the canonical self-inflicted defects. Prefer total constructions (scan all bytes/items) over fixed-width parses.
2. **Mirror-path check.** If the fix touches a read path, open the corresponding write path and confirm the invariant holds there too — and vice versa. A read-side normalization fix while the write side still stores bad values is an incomplete fix; say so and include the write side.
3. **Existing-data check.** Can rows/records/files already exist that violate the fixed invariant? If yes, the fix requires a data migration — state it, and state its failure plan (e.g., lowercasing a column can collide with a unique constraint on existing duplicate pairs; the migration needs a dedup step *first*). A fix that ignores existing bad data is incomplete.
4. **Constraint-value check.** Every threshold in the fix (`=== 0`, `< N`, `>= MAX`) must be read from the authoritative source and cited by file:line. Do not guess that the constraint is "non-empty" — find the actual minimum, maximum, or character set.
5. **Fix failure modes.** State what the fix does on malformed/hostile input: throw (loud) vs default (silent) — and confirm the fix cannot reintroduce, for *any* input, the bug class it prevents.
6. **Interaction check.** Does this fix activate or expose another finding? (Fixing a lookup bug can make a dormant rate-limit hole live; two fixes may need one shared migration.) Record every interaction in the Fix Plan with an ordering or ships-with constraint.
7. **Caller-contract check.** Does the fix change when a function resolves, what it returns, or what it throws? Grep the callers and confirm each tolerates the change; note any that don't.
8. **Empirical re-test.** If the finding was confirmed empirically, run the same harness against the fixed logic and record the output.

**If a fix cannot pass all eight checks, do not ship a partial patch.** Report the finding with `Fix: requires design work — [which checks failed and why]`. An honest "this needs a migration plan" beats a defective one-liner.

---

## Step 7: Generate the Report

Write to `.agents/research/YYYY-MM-DD-bug-hunt-<scope>.md` using the structure in `references/report-template.md`. Display the same content inline. **One table format — always.** No terminal-width detection, no compact/full variants.

Required sections (see template for exact layout):
1. Header: scope, lenses, runtime context, files read in full
2. **Guard Map** — the Step 2 file list
3. Summary counts (BUG / FRAGILE / OK / REVIEW)
4. **Issue Rating Table** — one row per BUG/FRAGILE: `# | Finding | Lens | Confidence | Urgency | Risk: Fix | Risk: No Fix | ROI | Blast Radius | Fix Effort`. Blast Radius uses the three-axis notation, e.g. `1 file`, `2 files + migration (collision risk)`, `3 files + cross-service`.
5. **Fix Plan & Interactions** — the section a reader acts on first: ordering constraints ("fix #2 only together with F6 — #2 alone opens an email-bombing path"), ships-with sets, shared migrations ("#2 and #8 share one users-table migration — write it once"), and fixes deferred to design work.
6. Detailed findings — each with: lens, assumption, violation scenario, consequence, current code, verified fix (or `requires design work`), Confidence + evidence (empirical command/output or trace citations)
7. Fragile code
8. Already Guarded — candidates that verification cleared, with the guard's file:line
9. **Refutation Log** — findings and sub-claims killed in Step 5, and what killed them
10. Needs Human Review — including all `Suspected`-confidence items

---

## Step 8: Follow-up — Phase-Gated Fix Workflow

Ask:

```
AskUserQuestion: "How would you like to proceed?"
Options: "Fix all bugs now (phase-by-phase)" / "Fix selected bugs" /
  "Create implementation plan" / "Report is sufficient"
```

**Phasing rules (all modes):**
- Phases are built from the **Fix Plan**, not just file proximity: ships-with sets are never split across phases, and ordering constraints are honored.
- A shared migration is written once, in the earliest phase that needs it.
- After each phase: build and run the project's tests. A phase is not complete until both pass.

**"Fix all bugs now":** before each phase, one gate:

```
AskUserQuestion: "Phase N: [name] ([count] fixes — [key files]). Proceed?"
Options: "Proceed (Recommended)" / "Proceed — skip remaining phase gates" /
  "Let's chat about this phase" / "Stop here"
```

Every phase gets this same gate until completion or opt-out. "Skip remaining gates" = batch mode. "Let's chat" = discuss, then re-prompt. "Stop here" = report what was completed.

**"Fix selected bugs":** present the findings as a multi-select, confirm once, then fix without per-bug prompting — the selection was the decision. Warn if a selection splits a ships-with set, and require explicit confirmation to proceed split.

**"Create implementation plan":** emit the Fix Plan as a numbered, dependency-ordered plan.

After fixes land, optionally run `bug-echo` on each fix's diff to sweep the codebase for sibling instances of the same pattern — Lens 8/9 findings in particular are usually a *class*, not an instance.

---

## Lens Selection Guide

| Situation | Lenses |
|---|---|
| Pre-release audit | All 9 |
| New feature just added | 1, 2, 5 |
| After a crash / incident | 3, 5, 7 |
| Intermittent failures | 2, 6 |
| Multiple backends / SDK + server | 8, 9, 1 |
| Data model or identity changes | 4, 9, 1 |
| New runtime/platform target | 7, 3 |

## Troubleshooting

| Problem | Solution |
|---|---|
| Too many findings | Narrow scope, or Quick 4 lenses |
| Findings feel theoretical | Raise the realism bar (Step 4.5) and demand an empirical check (Step 4.6) |
| Can't tell if guarded | Grep the guard map first; still unclear → REVIEW, never BUG |
| Fix keeps failing checklist | That's the checklist working — report `requires design work` |
| Huge file | Split by section, or delegate lens passes to Agent subprocesses; verification and refutation stay in the main thread |
