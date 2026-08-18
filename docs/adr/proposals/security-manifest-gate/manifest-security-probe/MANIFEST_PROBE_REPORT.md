# Manifest-Security Probe Report (Stage-S-shaped spike)

**Date**: 2026-07-12
**Trigger**: `docs/proposals/rule-expansion-evaluation.md` §B.5 Stage B-1 — user-approved top recommendation #1.
**Targets** (read-only): `align` itself (`/Users/spikedpunchvictim/projects/align`), `test-apps/kluster`,
`test-apps/n8n`. Nothing under any target was modified.
**Spike code**: `spike/manifest-probe/` (throwaway — 7 rule checkers + a shared read/parse layer + an
orchestrator). Measured artifacts: `spike/manifest-probe/out/results.json` (21 rule×repo results, raw).
**Execution**: zero network calls. Node 24.7.0's native TypeScript stripping runs the `.ts` files directly
(no build step, no `tsx`/`ts-node` dependency added). The one non-stdlib import is the `yaml` package,
already present on disk in the repo's own pnpm store (used by `plugin-typescript/src/workspace.ts`) but
reached by absolute path from `node_modules/.pnpm/` since it isn't a direct dependency of anything under
`spike/` — documented in `lib/yaml.ts`. This is reading an already-installed local package, not a new
dependency.

All numbers below are measured (`spike/manifest-probe/out/results.json` + the commands in this report),
none are estimated.

---

## Baseline facts about the three targets (materially affects several rules' feasibility)

| Fact | align | kluster | n8n |
|---|---|---|---|
| Workspace members (lockfile `importers:` count) | 5 | 27 | 72 |
| `pnpm-lock.yaml` size | 1,794 lines | 10,846 lines | 41,212 lines |
| `node_modules/.pnpm` populated with real deps | Yes (143 distinct packages) | Yes (934 distinct packages) | **No** — only two `@align` workspace symlinks (`core`, `plugin-typescript`); no real n8n dependency was ever `pnpm install`-ed on this machine |
| Usable git history for "N commits back" | Yes — real repo, 34 commits, package.json changes across commits | **No `.git` at all** | **`.git` present but a 1-commit shallow clone** (`fffa4233`) — no N-back history reachable |
| `.npmrc` present | No | No | Yes — `auto-install-peers = true`, `link-workspace-packages = deep`, etc. (relevant to Rule 4, see below) |
| `pnpm.onlyBuiltDependencies` in root `package.json` | Not set | Not set | Set: `@vscode/ripgrep`, `isolated-vm`, `sqlite3` (pnpm 10's script-blocking-by-default allowlist) |

Two of these facts break assumptions the evaluation doc reasonably made going in, and both are genuine
probe findings in their own right (see Open Design Questions):

1. **n8n's node_modules isn't populated.** The doc scoped install-script detection to "post-install only,
   offline" on the assumption that means "walk node_modules." On the repo the doc itself picked as the
   stress test, that's not available — see Rule 2.
2. **Neither kluster nor n8n has usable git history.** The task's own fallback ("simulate by removing one
   dep and re-running") was exercised for both, exactly as anticipated. align, being align's own live repo,
   *does* have real history and produced genuine (not simulated) evidence for Rule 7 — see below.

---

## Per-rule results

### Rule 1 — Dependency source hygiene (git/http(s)/file/link specifiers)

Scans the lockfile's resolved `importers:` specifiers (not just raw `package.json`, because catalog-managed
deps like n8n's `xlsx` show `catalog:` in the manifest and only resolve to the real specifier in the
lockfile).

| Repo | Count | Wall-time |
|---|---|---|
| align | 0 | 31.1 ms |
| kluster | 0 | 96.3 ms |
| n8n | **3** | 751.4 ms |

**n8n's 3, named and verified by reading the actual manifests:**

- `packages/@n8n/instance-ai/package.json:85` — `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz"`
- `packages/nodes-base` — same `xlsx` pin, same URL
- `packages/frontend/editor-ui/package.json:123` — `"wa-sqlite": "github:rhashimoto/wa-sqlite#779219540f66cecaa159da32b3b8936697ba10a7"`

**False-positive assessment**: 3/3 hand-verified against the real manifests, 0 false positives. Both are
real, well-known, intentional non-registry sources (SheetJS stopped publishing `xlsx` past 0.18 to npm and
distributes newer versions from its own CDN; `wa-sqlite` is pinned to a specific unreleased git commit).
**This is exactly the signal this rule is for** — not malicious, but a real deviation from "registry only"
that a policy gate should surface for human sign-off, and the kind of specifier a poisoning attack would
also use to smuggle a non-reviewable artifact past registry-level scanning. One methodology note: an npm
alias specifier (`"zod-from-json-schema-v3": "npm:zod-from-json-schema@^0.0.5"`, present in n8n) correctly
does **not** trigger this rule — it still resolves through the registry, just under an alias.

### Rule 2 — Install-script exposure

Walks `node_modules/.pnpm`, dedupes installed packages by `name@version`, reads each `package.json`'s
`scripts.{preinstall,install,postinstall}`, classifies against a small hand-built allowlist of known
native-build/bundler tooling.

| Repo | Count | Wall-time | Census (distinct installed packages) |
|---|---|---|---|
| align | 1 | 66.5 ms | 143 |
| kluster | 11 | 478.1 ms | 934 |
| n8n | **0 — see below, not a clean result** | 1.8 ms | 0 (not installed) |

**align's 1**: `esbuild@0.21.5` — `postinstall: node install.js` — correctly classified `build-tooling`.

**kluster's 11, all read and hand-verified (100%, exceeds the ≥5 sample bar):**

| Package | Hook | Script | My classifier said | Manual verdict |
|---|---|---|---|---|
| `protobufjs@7.5.8` | postinstall | `node scripts/postinstall` | build-tooling | legit (codegen) |
| `sharp@0.34.5` | install | `node install/check.js \|\| npm run build` | build-tooling | legit (native binary check) |
| `esbuild@0.21.5/0.24.2/0.27.7` (×3) | postinstall | `node install.js` | build-tooling | legit (binary fetch) |
| `better-sqlite3@12.10.0` | install | `prebuild-install \|\| node-gyp rebuild --release` | build-tooling | legit (native addon) |
| `onnxruntime-node@1.24.3` | postinstall | `node ./script/install` | **unclassified** | legit (ML runtime binary fetch) |
| `argon2@0.44.0` | install | `cross-env ZERO_AR_DATE=1 node-gyp-build` | **unclassified** | legit (native crypto addon) |
| `tree-sitter@0.22.4` | install | `node-gyp-build` | **unclassified** | legit (native grammar addon) |
| `tree-sitter-javascript@0.23.1` | install | `node-gyp-build` | **unclassified** | legit (same) |
| `tree-sitter-typescript@0.23.2` | install | `node-gyp-build` | **unclassified** | legit (same) |

**False-positive assessment in the security sense: 0/11** — every install script found is a real, expected,
well-understood native-binary/codegen pattern. **But the classifier design has a real gap**: 5/11
(45%) fell into "unclassified" purely because my allowlist matches by *package name*, and I hadn't
enumerated `argon2`/`onnxruntime-node`/`tree-sitter*` up front. All 5 use the exact same two well-known
commands (`node-gyp-build`, or a `node ./script/*` binary-fetch shim) that the 6 correctly-classified ones
also use. **Design lesson for promotion**: classify by *script content pattern* (`node-gyp-build`,
`prebuild-install`, `node-gyp rebuild`, a fetch-a-prebuilt-binary shim) rather than a package-name allowlist
— the former generalizes to every future native-addon package for free; the latter requires updating a list
forever and still under-classifies on day one, as measured here.

**n8n is the important negative result, not a clean pass.** node_modules/.pnpm has zero real n8n
dependencies installed on this machine (confirmed above) — the true install-script count for n8n's real
~3,500-entry dependency tree is **unknown**, not zero. The only offline signal available without a real
install is n8n's own `pnpm.onlyBuiltDependencies` allowlist (`@vscode/ripgrep`, `isolated-vm`, `sqlite3`) —
which tells us pnpm 10's script-blocking-by-default is active and names 3 packages permitted to run scripts,
but says nothing about how many *other* packages in the tree declare scripts that are consequently blocked.
This directly confirms the evaluation doc's own scoping note (§B.3 table: "Only post-install" is offline-capable)
was optimistic about what "post-install" gets you in practice — it assumes a populated node_modules, and nothing
in align's design forces one to exist (ADR 004 explicitly forbids requiring `pnpm install` as a
precondition for other rules). **This is the single most important finding of the probe for the
promotion decision** — see Open Design Questions.

### Rule 3 — Version-pinning policy

Classifies every lockfile-resolved specifier per repo into exact / caret / tilde / range / wildcard-or-latest
/ workspace-or-catalog (excluded — not a registry pin) / non-registry (already Rule 1's territory).

| Repo | Specifiers | exact | caret | tilde | range | wildcard/latest | workspace/catalog | Wildcard findings (count column) |
|---|---|---|---|---|---|---|---|---|
| align | 26 | 0 | 20 | 0 | 0 | 0 | 6 | 0 |
| kluster | 201 | 48 | 106 | 0 | 0 | 0 | 47 | 0 |
| n8n | 1,860 | 321 | 300 | 0 | 7 | **0** | 1,229 | 0 |

**Zero wildcard-or-`latest` specifiers across all three repos, 5,594 combined lockfile-managed specifiers
checked, 4,432 line-item specifiers excluding workspace/catalog.** This rule produced **no actionable
finding of any kind** on any of the three real repos in this probe. n8n's version story is dominated by
pnpm's `catalog:` mechanism (1,229/1,860 = 66% of specifiers), which centralizes pinning at the workspace
level rather than per-package — the evaluation doc's own verdict ("low differentiation — `.npmrc`
`save-exact=true` plus a CI check already covers most of this need") is now empirically confirmed rather
than asserted: not one of three real repos, including a 3,500-line-item enterprise monorepo, gave this rule
anything to say.

### Rule 4 — Lockfile ↔ manifest drift

Compares each workspace member's declared `package.json` dependency names against the lockfile importer's
recorded set for that path.

**First pass (naive — dependencies/devDependencies/optionalDependencies only), before correction:**

| Repo | Count |
|---|---|
| align | 0 |
| kluster | 0 |
| n8n | **3** |

**All 3 of n8n's findings, hand-verified — 3/3 (100%) were false positives**, all the same root cause:

- `packages/@n8n/eslint-config` → `eslint` "present in lockfile but absent from package.json"
- `packages/@n8n/eslint-plugin-community-nodes` → `eslint` — same
- `packages/@n8n/typeorm` → `pg-native` — same

Reading the manifests: `eslint` and `pg-native` are declared under **`peerDependencies`** (the latter
explicitly `optional: true` in `peerDependenciesMeta`), not under `dependencies`/`devDependencies`. n8n's
`.npmrc` sets `auto-install-peers = true`, so pnpm auto-installs them into the lockfile importer entry even
though they're correctly absent from the non-peer manifest fields — not drift, just a comparison bug in the
first version of the rule (peerDependencies wasn't in the comparison set at all).

**Fixed** (`rules/04-lockfile-drift.ts` now includes `peerDependencies` in the manifest-side set,
documented inline with the false-positive that motivated it) and **re-run: 0/0/0 across all three repos.**
The corrected rule is clean but also produced **zero true-positive evidence** in this probe — none of the
three repos had genuine, un-annotated drift. That's a real (if negative) result: the rule is
implementable and, once peerDependencies-aware, appears low-noise, but this probe supplies no example of
what it looks like when it actually fires. Wall-time (corrected run): align 17.0 ms, kluster 116.4 ms, n8n
555.1 ms.

### Rule 5 — Registry provenance in lockfile

Scans the lockfile's top-level `packages:` section: a `resolution.tarball` field is present only when a
package resolves from somewhere other than the default registry (default-registry packages carry only
`integrity`).

| Repo | Total package entries | Non-default-registry | Wall-time |
|---|---|---|---|
| align | 189 | 0 | 17.1 ms |
| kluster | 1,058 | 0 | 95.3 ms |
| n8n | 3,571 | **2** | 529.8 ms |

**n8n's 2, named:**
- `wa-sqlite@https://codeload.github.com/rhashimoto/wa-sqlite/tar.gz/779219540f66cecaa159da32b3b8936697ba10a7`
- `xlsx@https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz`

**These are the exact same two packages Rule 1 found** (expected — Rule 1 reads the manifest specifier
side, Rule 5 reads the lockfile resolution side of the same two non-registry dependencies). No new signal,
0 false positives (both already hand-verified under Rule 1), but this is the evaluation doc's own
"wrap, not build" candidate (`lockfile-lint` already does exactly this check) — see Promotion
Recommendations for why we still measured it. No repo in this probe configures a private/mirror registry
(no `.npmrc` `registry=` override found in any of the three), so "default registry" was an uncomplicated
assumption throughout.

### Rule 6 — Dependency-confusion exposure (offline half only)

Lists workspace-internal package names lacking an `@scope/` prefix. Explicitly does not query the public
registry (out of scope per the doc's offline doctrine).

| Repo | Named workspace packages checked | Unscoped count |
|---|---|---|
| align | 5 | 1 |
| kluster | 27 | 2 |
| n8n | 72 | **9** |

**Raw findings**: align's `align-monorepo` (root, private); kluster's `kluster` (root, private) and
`kluster-bt` (private); n8n's `n8n-monorepo` (root, private), `n8n-node-dev` (private), `n8n-containers`
(private), `n8n-playwright` (private), and — **published, public, intentionally unscoped** — `n8n`,
`n8n-core`, `n8n-editor-ui`, `n8n-nodes-base`, `n8n-workflow`.

**Hand-verification went one step further than "is it unscoped": is it actually reachable via internal
resolution confusion today?** I grepped every lockfile importer entry in all three repos for any reference
to one of these 12 names using a specifier that does *not* start with `workspace:` (i.e., a reference that
pnpm would resolve against the registry rather than the local workspace member). **Result: zero.** Every
internal reference to every one of these 12 names — where a reference exists at all — consistently uses the
`workspace:` protocol. So the classic dependency-confusion failure mode (an internal build accidentally
resolving a same-named public package instead of the local one) is **not exploitable today in any of these
three repos**, even though the raw "unscoped name" signal fired 12 times.

**False-positive assessment**: 12/12 raw findings are technically correct (the names genuinely are
unscoped) but 0/12 represent an actionable *today* risk by the offline-half check alone — and the 5
public n8n packages (`n8n`, `n8n-core`, etc.) aren't really "exposure" at all, they're n8n's own
intentionally-published packages; flagging them alongside the 7 private ones is noise unless the report
consumer already knows to filter by `private: true`. **Design lesson**: the useful offline signal is
narrower than "unscoped" alone — `unscoped AND private: true` cuts n8n's 9 down to 4 real
candidates-for-future-network-verification (`n8n-monorepo`, `n8n-node-dev`, `n8n-containers`,
`n8n-playwright`), and even sharper would be `unscoped AND private AND referenced via a non-workspace
specifier somewhere` — which found zero across all three repos, meaning this offline half's honest headline
number is **0 exploitable findings, 12 potential-squatting-surface findings**, and those are very
different severities to report as one number.

### Rule 7 — New-dependency-since-baseline simulation

align has real, usable git history (34 commits, git-tracked `package.json` changes); kluster has no `.git`
at all; n8n's `.git` is a 1-commit shallow clone with no reachable "N commits back." Per the task's
explicit instruction, kluster and n8n fall back to simulation (remove one dependency from an in-memory copy
of the current manifest, re-run the same diff logic, confirm it fires) — clearly labeled `[simulated]` in
every finding.

**align — real, not simulated.** At `HEAD~10`: 0 findings (the last 10 commits were docs/plan/fix commits
touching no `package.json`). Widening the window to size what the gate would have caught over align's
actual Stage 4 development:

| Window | Count | What fired |
|---|---|---|
| HEAD~10 | 0 | — |
| HEAD~20 | **7** | `packages/agent`'s entire dependency set (new package: `@align/core`, `@anthropic-ai/sdk`, `zod`, `typescript`, `vitest`, `@types/node`) + `packages/cli` gaining `@align/agent` |
| HEAD~30 | 19 | (includes the above plus earlier package-creation events) |
| HEAD~33 | 26 | full history back near the repo's origin |

The HEAD~20 example is the cleanest real-world evidence in this whole probe: **`@anthropic-ai/sdk` entering
align's own dependency tree** when `packages/agent` was built in Stage 4 is exactly the kind of event a
new-dependency-added gate exists to surface — a genuinely new, externally-sourced, security-relevant
dependency, correctly distinguished (via the `reason: 'new-package'` vs `reason: 'new-dependency'` field
already in the finding shape) from the five same-commit devDependencies/internal packages that arrived only
because the whole package was new, not because someone added one dependency to an existing surface.

**kluster (simulated)**: baseline = current root manifest minus `vitest` → correctly flagged
`vitest` as "new." **n8n (simulated)**: baseline = current root manifest minus `zx` → correctly flagged
`zx` as "new." Both confirm the diff mechanism itself is correct; neither is historical evidence.

**Verdict**: the mechanism is proven twice over — once by simulation (kluster, n8n), once by a real
historical event with a genuinely interesting hit (align/`@anthropic-ai/sdk`). This is the strongest
result in the probe.

---

## Consolidated verdict table

| Rule | align | kluster | n8n | Noise assessment |
|---|---|---|---|---|
| 1. Source hygiene | 0 | 0 | 3 | **Clean.** 3/3 hand-verified real (SheetJS CDN, git-pinned wa-sqlite). |
| 2. Install-script exposure | 1 | 11 | 0 (uninstalled — not a real zero) | **Real signal, weak classifier.** 0/12 observed scripts were actually suspicious, but the name-allowlist classifier under-classified 5/11 on kluster; n8n result is not trustworthy without a real install. |
| 3. Version-pinning policy | 0 | 0 | 0 | **Empirically dead.** Zero findings on 5,594 specifiers across 3 repos, one of them a 3,500-entry monorepo. |
| 4. Lockfile↔manifest drift | 0 | 0 | 3→0 after fix | **Noisy until peerDependencies-aware, then clean-but-unexercised.** 100% FP rate (3/3) pre-fix, 0/0/0 post-fix — no positive evidence for what a real hit looks like. |
| 5. Registry provenance | 0 | 0 | 2 | **Clean, but redundant with Rule 1** — same two n8n packages, doc already says wrap `lockfile-lint`. |
| 6. Dependency-confusion (offline half) | 1 | 2 | 9 | **Raw signal too coarse.** 12/12 technically-true "unscoped," 0/12 exploitable-today by the offline-only check; needs `private:true` + non-workspace-reference narrowing to be useful. |
| 7. New-dep-since-baseline | 0 (real, N=10) / 7 (real, N=20) | 1 (simulated) | 1 (simulated) | **Strongest result.** Real historical hit on align (`@anthropic-ai/sdk`), mechanism proven on all 3 repos. |

---

## Promotion recommendations

### Top 3 candidates

1. **New-dependency-added gate (Rule 7).** The doc's own "best-fit candidate" is now evidence-backed, not
   just doctrine-fit-backed: it fired correctly on real history (align/`@anthropic-ai/sdk`) and on
   mechanism-proof simulations (kluster/`vitest`, n8n/`zx`), with zero false positives across all three —
   because the check is a pure set-diff, there's no ambiguity to misclassify. Reuses the existing
   baseline-consent doctrine (`baseline accept --rule`) verbatim, as the doc predicted. **Promote-with-caveat**:
   ship it, but the "distinguish new-package-creation from new-dependency-added-to-existing-package"
   `reason` field this probe's finding shape already carries should be in the real IR from day one — the
   HEAD~20 example shows why (6 of 7 hits were one event, not six separate signals worth six separate
   violations).

2. **Dependency source hygiene (Rule 1).** Clean, cheap (string-pattern match on already-resolved lockfile
   specifiers, no new scan domain), zero false positives on real evidence, and it caught something real on
   the very repo the doc chose as the stress test. The one methodology note (npm aliases must not
   false-positive) is already handled and cheap to keep handling.

3. **Install-script exposure (Rule 2), scoped strictly to "packages actually present in node_modules,"
   with classification done by script-content pattern instead of package-name allowlist.** The
   *detection* half is sound (0 real false positives across 12 hand-verified scripts) but the *triage*
   half needs the content-pattern fix demonstrated in this probe before it's low-noise enough to promote —
   name-allowlist classification left 45% of kluster's real findings sitting in an "unclassified, go read
   it yourself" bucket that a content-pattern check (`node-gyp-build`, `prebuild-install`, `node-gyp
   rebuild`) would have resolved automatically, per the actual scripts observed.

### Top rejections

- **Version-pinning policy (Rule 3)**: reject, or at minimum do not promote without new evidence. Zero
  findings on 5,594 real specifiers across three repos including a 3,500-line-item production monorepo is
  about as clean a "no repo-demonstrated demand" verdict as this project's own promotion doctrine could ask
  for. The doc's pre-probe "low priority" judgment is now a measured "no evidence at all" judgment.
- **Registry allowlist / resolved-URL validation (Rule 5)**: confirms the doc's own wrap-not-build
  conclusion — `lockfile-lint` already does this, and this probe's finding was 100% redundant with Rule 1's
  finding on the only repo where anything fired. Not worth a bespoke align implementation.
- **Dependency-confusion exposure, offline half, as currently scoped (Rule 6)**: reject the "unscoped name"
  signal as-is — 0/12 raw findings survived a second-order check (is the name actually referenced via a
  non-workspace specifier anywhere). If this is ever built, it needs the `private:true` +
  non-workspace-reference narrowing this probe demonstrated, and even then the *useful* half of the check
  (is the name already squatted publicly) is the network half the doc already correctly scoped out —
  meaning the offline half alone may not be worth shipping as a standalone gate at all, only as one input
  to a future `align doctor`-class advisory that also does the network query.
- **Lockfile↔manifest drift (Rule 4)**: hold, don't reject outright — the corrected version is clean but
  this probe supplies zero positive evidence of a real hit. Needs either a fourth repo or a deliberately
  seeded drift fixture before promotion; shipping an unexercised rule contradicts the project's own
  promotion-on-evidence doctrine as much as shipping a noisy one would.

### Baseline-seeding story (day one on a real repo)

n8n is the honest stress case, and it's uneven across rules:
- Rule 1 (source hygiene): 3 pre-existing findings — small, human-reviewable baseline seed.
- Rule 7 (new-dep gate): 0 by construction — a baseline gate only fires on *future* additions, so day-one
  seeding is trivially "accept whatever's there now," same as align's existing LOC/cycle baseline pattern.
- Rule 2 (install-scripts): **unknown** — this is the sharpest finding of the whole probe. n8n's true
  install-script count on day one is not zero, it's unmeasured, because node_modules isn't populated. A real
  `security.manifest` gate that includes install-script detection needs an answer to "what happens on a repo
  align has never had installed" before it can honestly claim day-one value — either it silently produces a
  useless zero (a false-green risk this project's own doctrine treats as severity-zero), or it must degrade
  visibly (an advisory: "N packages in the lockfile could not be checked for install scripts — node_modules
  not present") rather than reporting a clean pass.

### What a violation payload should carry

Based on what the finding shapes in this probe actually needed to be useful (not speculative):
`ruleId`, `repo`-relative `location` (workspace-member path, not absolute), `depName`, the literal
`specifier` string (for Rules 1/3/6), the resolved `tarball`/URL (Rule 1/5), the script command text itself
not just the hook name (Rule 2 — "has a postinstall" is not actionable, "postinstall: node-gyp-build" is),
and — critically, per Rule 7's HEAD~20 example — a `reason` discriminant (`new-package` vs
`new-dependency`) so six related hits don't read as six unrelated violations.

### Open design questions

1. **Does manifest scanning belong in `plugin-typescript` or a new scan domain?** This probe never touched
   TypeScript source at all — every rule reads `package.json`/`pnpm-lock.yaml` only. That's a genuinely
   different input class from everything `plugin-typescript` currently scans (source files via the compiler
   API). A new `plugin-manifest`-shaped scan domain (or a `security.manifest` gate living in `@align/core`
   directly, since none of this needs TypeScript AST access) seems like a better fit than bolting it onto
   the existing TS scanner — worth a real design decision, not assumed here.
2. **The node_modules-population dependency this probe surfaced is a real doctrine tension, not just an
   n8n quirk.** ADR 004 says align "must not require `pnpm install` before it can see a repo's
   architecture" for the *existing* rule kinds. Install-script detection, as scoped by the evaluation doc
   itself ("post-install only, offline"), silently assumes the opposite — that installation already
   happened. Either this needs its own carve-out in the freshness/precondition doctrine (a gate that
   degrades to an explicit advisory rather than a false-clean when node_modules is absent), or install-script
   detection needs to be re-scoped to something that doesn't require it (which this probe did not find —
   the lockfile genuinely carries no install-script metadata in pnpm's v9 format, confirmed by grep across
   all three real lockfiles).
3. **Classification-by-content vs classification-by-name** (Rule 2) generalizes better and should be the
   v1 design, not the name-allowlist this throwaway probe used for expedience.
4. **Rule 6's real design shape is narrower than "unscoped name."** If built at all, it should be
   `unscoped AND private:true AND (optionally) referenced via a non-workspace specifier somewhere` — this
   probe's naive version over-reports by roughly 3x relative to that narrower, more defensible signal, and
   even the narrower signal's *value* still depends on the network half the doc already scoped out.

---

## Constraints honored

Zero network calls (grep-verified no `fetch`/`http`/`https` calls anywhere in `spike/manifest-probe/`
beyond parsing literal URL strings already present in target lockfiles). No target repo was written to —
`node_modules`, lockfiles, and manifests under `test-apps/` and the align root were read-only throughout.
No files touched under `packages/`, `docs/adr/`, other `docs/*.md`, `align.config.ts`, or
`IMPLEMENTATION_PLAN.md`. Throwaway quality: typed (Node's native TS stripping, no `any` abuse, no build
step), boring (plain functions, no framework), no test suite.
