// Project definition for the cross-version integration harness (ADR 025 §4).
//
// nest, pinned to a specific commit — npm workspaces, 9 packages under packages/*, engines.node
// >= 20. Verified 2026-08-08: `align init --accept-existing` detects 9 components in ~1.5s.
//
// The `violation` descriptor below is the one piece of nest-specific domain knowledge the
// mutations need (lib/mutations.mjs's `introduce-arch-violation` reads it): `packages/core`
// imports from `@nestjs/common` in ~120 files, and `packages/common` never imports back from
// `@nestjs/core` (verified by grep against the pinned commit, both directions, 2026-08-08) — a
// real, one-directional, deterministic dependency this pinned commit is guaranteed to have,
// letting a scenario forbid it and get a real, reproducible violation set tied to real files
// rather than a synthetic one.
export default {
  id: 'nest',
  repoUrl: 'https://github.com/nestjs/nest.git',
  // Pinned commit (ADR 025 §4, task brief). Re-verify with `git ls-remote <repoUrl> HEAD` before
  // assuming this is still the tip of the default branch — the harness fetches this exact sha
  // regardless of where the branch head has moved to since.
  sha: 'c3bc75c973813969aa676793e20a7cba12a9daf5',
  // `--legacy-peer-deps`: the pinned commit's own dependency graph has an unresolved ERESOLVE
  // conflict between `@apollo/server@5.5.1` (peer `graphql@^16.11.0`) and the root project's dev
  // dependency on `graphql@17.0.2` — a real conflict in nest's own tree at this commit, unrelated
  // to align, that a plain `npm ci` refuses. Verified 2026-08-09: without this flag, `npm ci`
  // fails before align is ever installed.
  installCmd: { command: 'npm', args: ['ci', '--legacy-peer-deps'] },
  violation: {
    fromComponent: 'core',
    toComponent: 'common',
    because:
      'integration harness (ADR 025): a deliberate, real violation for the prune/check scenarios — packages/core ' +
      'imports @nestjs/common in ~120 files at the pinned commit, and packages/common never imports back.',
  },
};
