// Project definition for the cross-version integration harness (ADR 025 §4) — the "second,
// deliberately incomplete project variant" increment 1 never built: "dependencies *not* installed
// ... to exercise ADR 023 tier 2 and the --allow-incomplete override as first-class scenarios
// rather than as an accident."
//
// Same pinned commit as `projects/nest.mjs` — this is NOT a different snapshot of nest, it is the
// SAME repo state with its own dependency install deliberately skipped, so `align check` sees
// unresolved external imports (`@nestjs/common`, `rxjs`, `reflect-metadata`, ...) and reports
// `complete: false` (the `missing-dependencies` advisory, ADR 023).
//
// `installCmd` is a genuine no-op — `prepareProjectBase` (lib/project.mjs) still clones the pinned
// commit, but never runs `npm ci`, so the cached base has NO node_modules at all for nest's own
// ~18 `dependencies` + ~91 `devDependencies`. This makes the base cheap to prepare (a shallow
// clone, no install — seconds, not the minutes nest's real `npm ci --legacy-peer-deps` takes).
//
// `alignOnlyInstall: true` tells `installAlignVersion` (lib/version-install.mjs) to strip the
// project's OWN `dependencies`/`devDependencies` from package.json before running `npm install` to
// add align itself. This is necessary, not cosmetic: verified empirically (2026-08-10) that a bare
// `npm install <align-pkg>` against a package.json that ALSO lists other, uninstalled dependencies
// installs those too (npm always reconciles the whole declared tree, regardless of which package
// name you pass on the command line) — there is no scoped "install just this package and leave the
// rest of package.json unresolved" mode in vanilla npm. Stripping the unrelated deps from the
// object before npm ever sees them is the only reliable way to keep this project's own dependency
// state genuinely incomplete while still installing a working align binary into node_modules.
export default {
  id: 'nest-incomplete',
  repoUrl: 'https://github.com/nestjs/nest.git',
  // Same pin as `projects/nest.mjs` — re-verify both together with `git ls-remote <repoUrl> HEAD`
  // before assuming either is still the branch tip.
  sha: 'c3bc75c973813969aa676793e20a7cba12a9daf5',
  installCmd: { command: 'node', args: ['-e', ''] },
  alignOnlyInstall: true,
  violation: {
    fromComponent: 'core',
    toComponent: 'common',
    because:
      'integration harness (ADR 025): the same real, deterministic violation projects/nest.mjs uses — ' +
      'packages/core imports @nestjs/common in ~120 files at the pinned commit, and packages/common never imports back. ' +
      'Reused here so the incomplete-deps scenarios seed real baseline debt the same way the complete-deps scenarios do.',
  },
};
