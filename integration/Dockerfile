# Cross-version integration harness (ADR 025). Builds align FROM THIS WORKING TREE (so 'local'
# targets are always testing the code actually under review, not whatever was last published),
# then runs the harness against it. Reproducibility for CI; `node integration/run.mjs` directly on
# a dev machine (no Docker) is the fast iteration loop — same runner, same scenarios, both paths.
#
# Build:  docker build -f integration/Dockerfile -t align-integration .
# Run:    docker run --rm align-integration --project nest --targets 0.1.4,local
#         docker run --rm align-integration --project nest --scenarios prune-errored-run-destroys-baseline --targets 0.1.4,local
FROM node:24-slim

# git: project.mjs's shallow-clone-by-sha. ca-certificates: both git's and npm's HTTPS fetches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Shims into /usr/local/bin, so this half needs root. The version pin is `corepack prepare` below,
# which runs as `node` on purpose — see the USER note.
RUN corepack enable

# THE HARNESS RUNS AS `node`, NOT root, AND THAT IS A TEST REQUIREMENT RATHER THAN HARDENING.
# `chmod 000` does not stop root: as root, `blind-spot-unreadable-retains` would find its
# directory perfectly readable, produce no `unreadable` blind spot, and test nothing. That
# scenario's mutation verifies the precondition and throws rather than passing vacuously, so
# before this line the Docker path could not run it at all. LEDGER D012's lesson — a scenario the
# gate does not really execute is not calibration — applied to the container as well as the
# runner. (`.github/workflows/ci.yml` already runs the harness non-root on the GitHub runner; this
# makes the two paths agree.)
#
# The switch happens BEFORE the install/build steps, not after, so every file under /workspace is
# written by `node` in the first place. Switching afterwards would need a `chown -R` across an
# installed monorepo — a duplicated layer of node_modules, for the same end state.
RUN mkdir -p /workspace/align && chown -R node:node /workspace
USER node
# Explicit rather than inherited: corepack and npm both cache under $HOME, and a HOME still
# pointing at /root would make every cache write fail as `node`.
ENV HOME=/home/node

WORKDIR /workspace/align

# Pinned to the exact version in the repo's package.json "packageManager" field (see .github/workflows/ci.yml's
# same pin) — do not float to a range here. Runs after `USER node` so the downloaded pnpm lands in
# the cache the runtime user actually reads (${HOME}/.cache/node/corepack); prepared as root it
# would sit in /root and be re-fetched, or fail, on first use.
RUN corepack prepare pnpm@11.8.0 --activate

# Build align from the working tree FIRST, as its own layer — this is what 'local' targets
# install (lib/version-install.mjs's `pnpm pack`). Copied and built before `integration/` so an
# integration-only edit doesn't invalidate the (much slower) build layer's cache.
COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY --chown=node:node packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm -r build

COPY --chown=node:node integration ./integration

# The harness clones projects and installs their dependencies into
# integration/results/.cache — writable, and where the caching that makes a second scenario run
# fast actually lives; not baked into the image (a project's pinned commit and its dependency
# state can go stale between image builds, but a re-run of the container reuses the cache via a
# mounted volume if the caller bind-mounts integration/results/.cache).
RUN mkdir -p integration/results

ENTRYPOINT ["node", "integration/run.mjs"]
CMD ["--project", "nest", "--targets", "local"]
