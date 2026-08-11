// ADR 025 §7 `skill` row: "print; --install; re-install after a version bump". Increment 2 does
// not attempt the "after a version bump" half (ADR 021 gap 3's stale-snapshot detection needs a
// SECOND, different align version re-installing over the first — a genuinely cross-version
// scenario shape none of the harness's version-install plumbing has been pointed at yet); this
// covers plain print and `--install`'s idempotent write.
//
// `.claude/skills/align/SKILL.md` is outside `lib/capture.mjs`'s fixed `.align/*` capture catalog
// (deliberately — see `export-ir-then-check-untrusted.mjs`'s comment for the same limitation), so
// this scenario proves the write through the COMMAND's own behavior (the stdout path it prints,
// and a stable rendered heading) rather than a captured-file assertion.
export default {
  id: 'skill-install',
  project: 'nest',
  description: 'align skill prints the guide; --install writes .claude/skills/align/SKILL.md idempotently.',
  steps: [
    { install: 'target' },
    { run: 'init --accept-existing', expect: { exit: 0, stdoutContains: 'Detected 9 component(s)' } },
    { run: 'skill', expect: { exit: 0, stdoutContains: '# align — LLM skill guide' } },
    { run: 'skill --topic authoring', expect: { exit: 0, stdoutContains: 'Rule kinds' } },
    { run: 'skill --topic fixing', expect: { exit: 0 } },
    { run: 'skill --topic bogus', expect: { exit: 1 } },
    { run: 'skill --install', expect: { exit: 0, stderrContains: 'Wrote' } },
    { snapshot: 'after-first-install' },
    // Idempotent re-install: same content, no error, no drift in align.config.ts/CLAUDE.md.
    { run: 'skill --install', expect: { exit: 0 } },
    { assert: { kind: 'fileUnchanged', file: 'CLAUDE.md', since: 'after-first-install' } },
  ],
};
