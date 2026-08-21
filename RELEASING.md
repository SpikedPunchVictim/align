# Releasing align to npm

align publishes five packages, versioned **in lockstep** (all five always share one version):

- `@spikedpunch/align-core`
- `@spikedpunch/align-plugin-typescript`
- `@spikedpunch/align-agent`
- `@spikedpunch/align-cli`
- `@spikedpunch/create-align`

`@spikedpunch/create-align` is the primary consumer onboarding path — `pnpm create @spikedpunch/align`
(equivalently `npm init @spikedpunch/align` / `yarn create @spikedpunch/align`) installs
`@spikedpunch/align-cli` + `@spikedpunch/align-core` as local devDependencies of the target repo,
pinned to `create-align`'s own version, then delegates to `align init`. Keeping it in lockstep with
the other four is what makes that pin correct on every release — a stale `create-align` would
install a stale `align-cli`/`align-core` pair forever.

There are two flows: a **one-time local bootstrap** (required before CI can ever publish), and the
**routine tagged release** (CI does the work). Read the bootstrap section first — it is not
optional.

---

## Why the first publish must be local

Automated CI publishing uses **npm Trusted Publishing (OIDC)** — GitHub Actions proves its identity
to npm with a short-lived token, so no long-lived `NPM_TOKEN` secret is stored anywhere. But a
trusted publisher is configured **per package, in that package's settings on npmjs.com** — which
means **the package must already exist before you can register CI as its publisher**.

So the order is fixed:

1. Publish `0.1.0` of all five packages **from your machine** (authenticated as you).
2. Register this repo's `release.yml` as a Trusted Publisher on each of the five now-existing packages.
3. From then on, every release is a `git tag` — CI publishes tokenlessly with provenance.

---

## One-time prerequisites

- An npm account with **2FA enabled** (`npmjs.com` → account settings).
- Ownership of the **`@spikedpunch` scope**. If it's not your username, create a free npm
  organization named `spikedpunch` (public scoped packages are free): npmjs.com → *Add organization*.
- Local login: `npm login` (or `npm login --scope=@spikedpunch`).
- A clean working tree on `main` at the commit you intend to release.

---

## Step 1 — Local bootstrap publish (one time)

```bash
# Clean, reproducible build. dist/ is gitignored, so it MUST be rebuilt before publish.
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r test
pnpm check                      # align dogfood — self-check must be green

# Inspect exactly what will ship (expect: dist/**, package.json, README.md, LICENSE — no src/, no tests).
pnpm --filter @spikedpunch/align-core pack
tar -tzf spikedpunch-align-core-*.tgz
rm spikedpunch-align-core-*.tgz

# Dry run the whole set first, then publish for real.
pnpm -r publish --access public --dry-run
pnpm -r publish --access public
```

Notes:

- **Use `pnpm publish`, not `npm publish`.** pnpm rewrites the internal `workspace:*` deps to the
  concrete version (`0.1.0`) at pack time; bare `npm publish` would ship a broken `workspace:*`
  specifier. `pnpm -r publish` also publishes in dependency order (core first, cli last), so the
  CLI's dependencies exist on the registry before the CLI itself.
- With 2FA you'll be prompted for a one-time code; pass it non-interactively with `--otp=123456`.
- If pnpm complains about the git branch/tree state during a deliberate local publish, add
  `--no-git-checks`.

Verify all five appear at `https://www.npmjs.com/package/@spikedpunch/align-cli` (and the other four).

---

## Step 2 — Register CI as a Trusted Publisher (one time, per package)

For **each** of the five packages, on npmjs.com:

1. Go to the package → **Settings** → **Publishing access** (a.k.a. *Trusted Publisher*).
2. Add a GitHub Actions publisher with these fields:
   - **Organization / user**: `SpikedPunchVictim`
   - **Repository**: `align`
   - **Workflow filename**: `release.yml`
   - **Environment**: leave blank (the workflow does not use a GitHub Environment).
3. Save.

Once all five are registered, CI can publish without any stored npm credentials.

> If you later want to *require* a review gate before publishing, add an `environment:` to the
> `release` job in `release.yml` and set the same environment name in each package's trusted-publisher
> config — but that is optional and not wired up today.

---

## Step 3 — Routine release (every version after bootstrap)

The full checklist. **Three edits, then two gates, then the tag.** It used to be documented as one
command, which is why the two non-obvious edits were repeatedly missed.

`packages/cli/package.json`'s `version` is the **single source of truth** for align's version.
Nothing else hardcodes it: `ALIGN_VERSION` reads that file at module load
(`packages/cli/src/telemetry/process-context.ts`), `migration-registry-completeness.test.ts` reads
it directly rather than trusting the constant, and the integration harness derives it through
`integration/lib/align-version.mjs`. Do not add a fourth place that stores a version — derive it.

### 3.1 — Bump the five packages

```bash
pnpm release:version <x.y.z>
```

Writes `<x.y.z>` into all five publishable `package.json` files, in lockstep. It prints the
remaining steps too, so you do not have to come back here.

### 3.2 — Add a migration-registry entry

`packages/cli/src/migrations/registry.ts`. Add a **new** constant and a **new** entry to the
`MIGRATION_REGISTRY` list.

> **Do not re-key the existing entry.** The registry is *one entry per released version, applied in
> ascending order across a detected range*. Editing the newest entry's version does not add a
> release — it withdraws the previous release's validators and transforms from everyone who has not
> upgraded past it. Doing this during the 0.2.0 → 0.2.1 bump would have silently dropped 30 upgrade
> notes, two validators and the `**`-selector transform for every 0.1.4 user. This repo has shipped
> the same defect once before, keyed to 0.1.4; the file's own header describes it.

If the release moves no fingerprints and needs no migration, the entry still exists and carries the
notes, with `validators: []` and a comment saying that emptiness is a **claim** rather than an
omission — a validator that fires on nothing is worse than none, because it implies align checked
something.

*Fails loudly if forgotten* — `migration-registry-completeness.test.ts` asserts the version in
`packages/cli/package.json` has an entry, and `hasNotesForVersion` asserts the entry carries notes.

### 3.3 — Author the `UPGRADING.md` section, then recompile

Add a `## <x.y.z>` section with one `###` note per user-visible change. Then:

```bash
node packages/cli/scripts/compile-upgrading-notes.mjs   # UPGRADING.md -> notes.generated.ts
```

`UPGRADING.md` is the single authored record (ADR 021); `notes.generated.ts` is its compiled form
and is what ships in the npm package. Never hand-edit the generated file.

*Fails loudly if forgotten* — `migration-notes-drift.test.ts` compares an embedded content hash.

### 3.4 — Verify

```bash
pnpm build && pnpm typecheck && pnpm test    # ~26s — the three edits above must be green together
pnpm test:harness                            # the integration harness's own unit tests
node packages/cli/dist/index.js check        # align on align; red is blocking
node packages/cli/dist/index.js doctor       # advisory only, always exits 0
pnpm integration:release                     # THE GATE: every project x 0.1.4,local (ADR 025 §6)
```

`integration:release` is the one that matters and the one that takes ~25 minutes. Read two things in
its output rather than only its exit code:

- **`gate target 'local': all scenarios passed`** — for every project.
- **`target '0.1.4' calibration: all N pinned scenario(s) went RED as required`** — the pinned
  scenarios reproduce defects a published version demonstrably has. If one of them *passes*, the
  harness has stopped being able to detect the regression it exists to catch. If one *errors*, its
  assertions never ran and it proved nothing; both are release blockers and both are reported.

### 3.5 — Regenerate the dogfood artifacts (only if they changed)

```bash
node packages/cli/dist/index.js skill --install    # .claude/skills/align/SKILL.md carries a version stamp
node packages/cli/dist/index.js export-ir          # .align/ruleset-ir.json, if align.config.ts changed
```

`.align/version.json` is **not** edited by hand. It records which version last reconciled the
baseline, and align stamps it on the next baseline-writing command. Editing it would assert a
reconciliation that never happened.

### 3.6 — Commit, tag, push

```bash
git commit -am "release: v<x.y.z>"
git tag -a v<x.y.z> -m "v<x.y.z>"    # -a is REQUIRED, see below
git push --follow-tags               # pushing the tag triggers .github/workflows/release.yml
```

> **The tag must be ANNOTATED (`-a`), and this line used to say `git tag v<x.y.z>`.**
> `git push --follow-tags` pushes only *annotated* tags. A lightweight tag — what plain `git tag`
> creates — is silently left behind: the branch pushes, git reports success, and
> `.github/workflows/release.yml` never fires because no tag ref arrives. Nothing publishes and
> nothing says why. Caught 2026-08-21 while releasing 0.2.1, by checking `git cat-file -t` against
> the previous release (`v0.2.0` is `tag`, i.e. annotated; `v0.1.4` is `commit`, i.e. lightweight —
> so the repo has shipped both and the procedure never settled it). Verify before pushing:
>
> ```bash
> git cat-file -t v<x.y.z>    # must print: tag
> ```

> **`pnpm install --lockfile-only` is NOT needed for a version bump.** `scripts/bump-version.mjs`
> used to print that line, contradicting its own header. Verified 2026-08-21: internal deps are
> recorded in `pnpm-lock.yaml` as `specifier: workspace:*` / `version: link:packages/core` — no
> version number appears anywhere — every `0.2.0` string in that file belongs to a third-party
> package (`forwarded`, `ip-address`), and the `v0.2.0` release commit did not touch it. Run it when
> you change dependencies; never for a bump.

### What is NOT on this list, and why

- **`KNOWN_ALIGN_VERSIONS`** (the harness's version scrub list) used to be step 4 here, and it was
  the only step whose omission **no test could detect** — it silently stopped normalizing `local`'s
  own version in captured output. It is now derived from `packages/cli/package.json` via
  `integration/lib/align-version.mjs`, so the step no longer exists. `align-version.test.mjs` guards
  the derivation, mutation-checked against the hand-written list it replaced.
- **`PUBLISHED_ALIGN_VERSIONS`** in that same module lists versions live on npm. Append after a
  release ships if you want its version string scrubbed when it is used as an explicit `--targets`
  entry. Forgetting is cosmetic, not silent breakage.
- **The lockfile** — see above.

The `release.yml` workflow then, on the `v<x.y.z>` tag:

1. checks that the tag matches `packages/core`'s version (guards a forgotten `release:version`),
2. builds, typechecks, tests, and runs the align self-dogfood,
3. **runs the cross-version integration harness across every project** (`pnpm integration:release`) —
   ADR 025 §6's "required before publish", and a red harness fails the job so nothing is published,
4. uploads the harness results as an artifact (90 days), then
5. runs `pnpm -r publish --access public --no-git-checks --provenance`.

Step 3 is minutes. It is deliberately inside this workflow rather than a separate one: until
LEDGER D059 it ran on `release: published` in `ci.yml` while publishing happened on the tag push, so
the two raced and the "required" gate could not block anything.

Every published tarball carries a signed **provenance** attestation linking it to this repo, the
commit, and the workflow run.

---

## Testing an unreleased build against an external repo

An unreleased build carries the **same version string as the last published release** until you
bump it. align's version-skew advisory (`packages/cli/src/version-skew.ts`) fires by comparing the
running binary's version against the target repo's installed `@spikedpunch/align-core` — so on an
unbumped build the two always match, and the advisory stays silent by construction, exactly during
the kind of test it exists to catch. **No skew advisory here is not evidence of compatibility** —
it just means you haven't bumped.

To get a real signal, bump to a prerelease version first — uncommitted, local only
(`scripts/bump-version.mjs` accepts an `x.y.z-prerelease` suffix):

```bash
node scripts/bump-version.mjs 0.1.5-dev.0    # writes the prerelease string into all five package.json files
pnpm -r build
# link/install this build into the external repo, then run `align check` / `align_check` there —
# a version mismatch now fires the advisory against anything pinned to a release.
```

**Revert the bump before committing anything else** — the prerelease string must never land in a
real commit:

```bash
git checkout -- packages/*/package.json
```

---

## Fallback: token-based publishing

Trusted Publishing (OIDC) is exchanged most reliably by the `npm` CLI; the release workflow relies
on pnpm 11.8.0 performing the same exchange. If a CI publish fails on authentication (not on a
build/test gate), fall back to a token without changing the release flow:

1. npmjs.com → **Access Tokens** → **Generate** → **Granular Access Token** with *Read and write*
   on the `@spikedpunch` packages. (A classic **Automation** token also works and bypasses 2FA in CI.)
2. Add it as the GitHub repo secret **`NPM_TOKEN`** (repo → Settings → Secrets and variables → Actions).
3. In `release.yml`, the `id-token: write` permission is no longer needed; add this env to the
   **publish step** instead:

   ```yaml
   - name: Publish to npm
     env:
       NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
     run: pnpm -r publish --access public --no-git-checks --provenance
   ```

   (`setup-node` with `registry-url` already writes the `.npmrc` that consumes `NODE_AUTH_TOKEN`.)

Token-based publishing skips the per-package trusted-publisher registration in Step 2, at the cost
of a long-lived secret you should rotate periodically. You can migrate back to OIDC at any time.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `402 Payment Required` on first publish | Scoped packages default to private. Ensure `publishConfig.access: public` (already set in every package.json) and pass `--access public`. |
| `workspace:*` shows up on the published package | You used `npm publish` instead of `pnpm publish`. Always publish via pnpm. |
| CLI installs but its deps 404 | A package published out of order, or one of the five failed mid-run. `pnpm -r publish` handles ordering; re-run it — already-published versions are skipped. |
| Release workflow auth error | See *Fallback: token-based publishing* above. |
| `You cannot publish over the previously published versions` | The version already exists. Bump with `pnpm release:version` and re-tag. |

## Upgrade notes

When a release changes violation fingerprints, component classification, or any other behaviour
a consumer has to act on, record it in [`UPGRADING.md`](./UPGRADING.md) **in the same commit as
the change**, not at release time. Baseline-churn instructions in particular are easy to lose:
a consumer whose accepted debt stops matching needs the exact `align baseline prune` /
`align baseline accept` sequence, and the order matters (see that file for why `prune` must run
before `check`).
