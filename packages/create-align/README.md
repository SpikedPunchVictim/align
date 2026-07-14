# create-align

Bootstraps [align](https://github.com/SpikedPunchVictim/align) into an **existing** repo. This is
the package `pnpm create @spikedpunch/align` (equivalently `npm init @spikedpunch/align`, `yarn
create @spikedpunch/align`) expands to — you don't install it directly.

```bash
cd /path/to/your/repo   # must already have a package.json — run `pnpm init` first if not
pnpm create @spikedpunch/align
```

## What it does

1. Requires an existing `package.json` in the current directory (new-project scaffolding is out of
   scope — this augments a repo you already have).
2. Detects your package manager (`pnpm` / `npm` / `yarn`) from the `packageManager` field in
   `package.json`, falling back to lockfile presence (`pnpm-lock.yaml` / `yarn.lock` /
   `package-lock.json`), defaulting to `npm`.
3. Installs `@spikedpunch/align-cli` and `@spikedpunch/align-core` as devDependencies, pinned to
   **this package's own version** (lockstep — e.g. `@spikedpunch/align-cli@0.1.1`). No
   confirmation prompt — running the install immediately is the point of the command.
4. Delegates to the freshly-installed local `align` binary's `align init` — detects components,
   writes a starter `align.config.ts`, seeds the baseline. create-align never reimplements any of
   init's file-writing.
5. Prints next steps (`align check`, `align doctor`).

## Flags

| Flag | Meaning |
| --- | --- |
| `--yes`, `-y` | Fully non-interactive. Also forwarded to `align init`, which uses it to default its own script-offer prompt to yes (baseline seeding still requires `--accept-existing` explicitly — consent to tolerate existing debt is never inferred from `--yes` alone). |
| `--pm <pnpm\|npm\|yarn>` | Override package-manager detection. |
| anything else | Forwarded verbatim to `align init` — e.g. `--greenfield`, `--accept-existing`. |

```bash
pnpm create @spikedpunch/align --yes --accept-existing
pnpm create @spikedpunch/align --greenfield
pnpm create @spikedpunch/align --pm npm
```

## Workspaces (monorepos)

In a workspace root, `create-align` installs the two devDependencies at the root — where `align
init` writes `align.config.ts`, so it can resolve `@spikedpunch/align-core`. It detects a workspace
root (a `pnpm-workspace.yaml`, or a `workspaces` field in `package.json`) and adds the flag the
package manager requires: **pnpm** `-w` (otherwise `ERR_PNPM_ADDING_TO_ROOT`), **yarn classic** `-W`.
**npm** needs no flag. **yarn berry (v2+)** is unverified — it neither needs nor accepts `-W`; if
`create-align` fails on a yarn-berry workspace, install the two devDependencies by hand and run
`yarn align init`.

## Zero runtime dependencies

Built on `node:` built-ins only (`child_process`, `fs`, `path`, `url`) — no prompt library, no
install lifecycle script. See the root repo's `README.md` for the full align documentation.
