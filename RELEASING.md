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

```bash
pnpm release:version 0.2.0          # writes 0.2.0 into all five package.json files
pnpm install --lockfile-only        # refresh pnpm-lock.yaml to match
git commit -am "release: v0.2.0"
git tag v0.2.0
git push --follow-tags              # pushing the tag triggers .github/workflows/release.yml
```

The `release.yml` workflow then, on the `v0.2.0` tag:

1. checks that the tag matches `packages/core`'s version (guards a forgotten `release:version`),
2. builds, typechecks, tests, and runs the align self-dogfood, and
3. runs `pnpm -r publish --access public --no-git-checks --provenance`.

Every published tarball carries a signed **provenance** attestation linking it to this repo, the
commit, and the workflow run.

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
