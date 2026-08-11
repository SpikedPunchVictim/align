// ADR 025 §7 `docs` row: "topic list; each topic renders" — "prose is version-matched to the
// installed binary". Doesn't need a real repo state beyond an installed align, but runs inside the
// standard project working copy like every other scenario (README's `install: 'target'`
// convention) rather than inventing a second mechanism for a repo-independent command.
export default {
  id: 'docs-topics',
  project: 'nest',
  description: 'align docs lists every topic; each one renders; an unknown topic fails cleanly with the known-topic list.',
  steps: [
    { install: 'target' },
    {
      run: 'docs',
      expect: {
        exit: 0,
        stdoutContains: 'documentation',
        stdoutMatches: 'config\\s+align\\.config\\.ts API',
      },
    },
    { run: 'docs config', expect: { exit: 0, stdoutContains: 'align docs: config' } },
    { run: 'docs selectors', expect: { exit: 0, stdoutContains: 'align docs: selectors' } },
    { run: 'docs baseline', expect: { exit: 0, stdoutContains: 'align docs: baseline' } },
    { run: 'docs untrusted', expect: { exit: 0, stdoutContains: 'align docs: untrusted' } },
    { run: 'docs mcp', expect: { exit: 0, stdoutContains: 'align docs: mcp' } },
    { run: 'docs commands', expect: { exit: 0, stdoutContains: 'align docs: commands' } },
    {
      run: 'docs bogus-topic-name',
      expect: { exit: 1, stderrContains: "Unknown docs topic 'bogus-topic-name'" },
    },
  ],
};
