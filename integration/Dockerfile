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

# Pinned to the exact version in the repo's package.json "packageManager" field (see .github/workflows/ci.yml's
# same pin) — do not float to a range here.
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

WORKDIR /workspace/align

# Build align from the working tree FIRST, as its own layer — this is what 'local' targets
# install (lib/version-install.mjs's `pnpm pack`). Copied and built before `integration/` so an
# integration-only edit doesn't invalidate the (much slower) build layer's cache.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm -r build

COPY integration ./integration

# The harness clones projects and installs their dependencies into
# integration/results/.cache — writable, and where the caching that makes a second scenario run
# fast actually lives; not baked into the image (a project's pinned commit and its dependency
# state can go stale between image builds, but a re-run of the container reuses the cache via a
# mounted volume if the caller bind-mounts integration/results/.cache).
RUN mkdir -p integration/results

ENTRYPOINT ["node", "integration/run.mjs"]
CMD ["--project", "nest", "--targets", "local"]
