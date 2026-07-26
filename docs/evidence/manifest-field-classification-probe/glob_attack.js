// Adversarial re-scoring of the manifestField probe's Q1 claim.
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/Users/spikedpunchvictim/projects/align/docs/evidence/manifest-field-classification-probe/backstage-roles.json', 'utf8'));

console.log('total packages:', data.length);

// Role counts
const byRole = {};
for (const p of data) (byRole[p.role] ||= []).push(p);
console.log('\nrole counts:');
for (const [r, ps] of Object.entries(byRole).sort((a,b)=>b[1].length-a[1].length)) console.log(' ', r, ps.length);

// Tree split
const trees = {};
for (const p of data) { const t = p.dir.split('/')[0]; (trees[t] ||= []).push(p); }
console.log('\ntree split:');
for (const [t, ps] of Object.entries(trees)) {
  const roles = {};
  for (const p of ps) roles[p.role] = (roles[p.role]||0)+1;
  console.log(' ', t, ps.length, JSON.stringify(roles));
}

// Simple matcher for align-ish dialect: *, **, {a,b} — implement via regex on dir basename
function segMatch(pattern, str) {
  // expand braces (single level)
  function expand(pat) {
    const m = pat.match(/\{([^{}]*)\}/);
    if (!m) return [pat];
    const parts = m[1].split(',');
    const out = [];
    for (const alt of parts) for (const e of expand(pat.slice(0, m.index) + alt + pat.slice(m.index + m[0].length))) out.push(e);
    return out;
  }
  return expand(pattern).some(p => {
    const rx = new RegExp('^' + p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    return rx.test(str);
  });
}

// Classifier = ordered list of [pattern-on-dir, role]. Patterns are "tree/name-glob".
function score(rules, opts = {}) {
  let correct = 0, wrong = [], unmatched = [];
  for (const p of data) {
    let assigned = null;
    for (const [pat, role] of rules) {
      const [tree, ...rest] = pat.split('/');
      const namePat = rest.join('/');
      const [ptree, pname] = [p.dir.split('/')[0], p.dir.split('/').slice(1).join('/')];
      const treeOk = tree === '*' || tree === ptree || segMatch(tree, ptree);
      if (treeOk && segMatch(namePat, pname)) { assigned = role; break; }
    }
    if (assigned === p.role) correct++;
    else if (assigned === null) unmatched.push(p);
    else wrong.push({ dir: p.dir, role: p.role, got: assigned });
  }
  console.log(`\n=== ${opts.name}: ${correct}/${data.length} = ${(100*correct/data.length).toFixed(1)}%`);
  if (opts.verbose) {
    console.log('misclassified:', wrong.length, 'unmatched:', unmatched.length);
    for (const w of wrong.slice(0, opts.limit ?? 100)) console.log('  WRONG', w.dir, 'is', w.role, 'got', w.got);
    for (const u of unmatched.slice(0, opts.limit ?? 100)) console.log('  UNMATCHED', u.dir, 'is', u.role);
  }
  return { correct, wrong, unmatched };
}

// --- Arm 1: reproduce the probe's claimed classifier (~73.4%) ---
const probeRules = [
  ['*/*-backend-module-*', 'backend-plugin-module'],
  ['*/*-backend-module', 'backend-plugin-module'],
  ['*/cli-module-*', 'cli-module'],
  ['*/*-backend', 'backend-plugin'],
  ['*/*-common', 'common-library'],
  ['*/*-node', 'node-library'],
  ['*/*-react', 'web-library'],
  ['plugins/*', 'frontend-plugin'],
];
score(probeRules, { name: 'probe-style conventions only', verbose: false });

// --- Arm 2: smarter conventions. Add suffix variants observed in data. ---
// First inspect: what suffixes exist per role?
console.log('\nname-suffix inventory per role (last hyphen token of dir basename):');
for (const [r, ps] of Object.entries(byRole)) {
  const suf = {};
  for (const p of ps) {
    const base = p.dir.split('/').pop();
    const tok = base.split('-').pop();
    suf[tok] = (suf[tok]||0)+1;
  }
  console.log(' ', r, JSON.stringify(Object.fromEntries(Object.entries(suf).sort((a,b)=>b[1]-a[1]))));
}

// --- Arm 3: enumerate the packages/ tree exactly (it's small and stable), conventions for plugins/ ---
const pkgTree = data.filter(p => p.dir.startsWith('packages/'));
console.log('\npackages/ tree size:', pkgTree.length);
const enumRules = pkgTree.map(p => [p.dir, p.role]);
const hybrid = [
  ...enumRules,
  ['plugins/*-backend-module-*', 'backend-plugin-module'],
  ['plugins/*-backend-module', 'backend-plugin-module'],
  ['plugins/*-backend', 'backend-plugin'],
  ['plugins/*-common', 'common-library'],
  ['plugins/*-node', 'node-library'],
  ['plugins/*-react', 'web-library'],
  ['plugins/*', 'frontend-plugin'],
];
score(hybrid, { name: 'enumerate packages/* + conventions for plugins/*', verbose: true, limit: 70 });

// --- Arm 4: theoretical max — full enumeration (brace list of every dir) ---
score(data.map(p => [p.dir, p.role]), { name: 'full enumeration (233 explicit entries)' });

// --- Arm 5: smarter conventions incl. extra suffixes, no enumeration ---
const smart = [
  ['*/*-backend-module-*', 'backend-plugin-module'],
  ['*/*-backend-module', 'backend-plugin-module'],
  ['*/cli-module-*', 'cli-module'],
  ['packages/cli', 'cli'],
  ['*/*-cli', 'cli'],
  ['*/*-backend', 'backend-plugin'],
  ['*/*-common', 'common-library'],
  ['*/*-node', 'node-library'],
  ['*/*-react', 'web-library'],
  ['*/*-test-utils', 'node-library'],   // guess: test-utils are node-libraries?
  ['packages/*', 'node-library'],       // packages/ majority role?
  ['plugins/*', 'frontend-plugin'],
];
score(smart, { name: 'smarter conventions (test-utils, packages/* default)', verbose: false });
