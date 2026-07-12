/** One-off: characterize n8n's relative/alias unresolvable specifiers. */
import { scanRepo } from './scanner.js';

const { graph } = scanRepo('/Users/spikedpunchvictim/projects/align/test-apps/n8n', ['packages']);
const rel = graph.uncertain.filter(
  (u) =>
    u.reason === 'unresolvable-specifier' &&
    ((u.specifierPreview ?? '').startsWith('.') ||
      (u.specifierPreview ?? '').startsWith('@/') ||
      (u.specifierPreview ?? '').startsWith('#')),
);
const byPrefix = new Map<string, number>();
for (const u of rel) {
  const s = u.specifierPreview ?? '';
  const p = s.startsWith('@/') ? '@/ (bundler alias)' : s.startsWith('#') ? '# (imports map)' : 'relative';
  byPrefix.set(p, (byPrefix.get(p) ?? 0) + 1);
}
console.log('by prefix:', [...byPrefix.entries()]);

const relOnly = rel.filter((u) => (u.specifierPreview ?? '').startsWith('.'));
const exts = new Map<string, number>();
for (const u of relOnly) {
  const m = (u.specifierPreview ?? '').match(/\.[a-z0-9]+$/i);
  exts.set(m?.[0] ?? '(no ext)', (exts.get(m?.[0] ?? '(no ext)') ?? 0) + 1);
}
console.log('relative by trailing extension:', [...exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12));
console.log('non-asset relative samples:');
for (const u of relOnly.filter((x) => !/\.(css|scss|svg|png|json|vue|md)$/.test(x.specifierPreview ?? '')).slice(0, 10)) {
  console.log(' ', `${u.file}:${u.line}`, u.specifierPreview);
}
