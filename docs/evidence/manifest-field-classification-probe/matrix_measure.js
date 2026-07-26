// Approximate the Q2 measurement the probe skipped: run backstage's role matrix
// over the declared-dependency graph of the 233 role-tagged packages.
const fs = require('fs');
const path = require('path');
const ROOT = '/Users/spikedpunchvictim/temp/enterprise-apps/backstage';
const roles = JSON.parse(fs.readFileSync('/Users/spikedpunchvictim/projects/align/docs/evidence/manifest-field-classification-probe/backstage-roles.json', 'utf8'));

const info = {}; // name -> {role, pluginId, deps[]}
for (const p of roles) {
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, p.dir, 'package.json'), 'utf8'));
  info[p.name] = {
    role: p.role,
    pluginId: pj.backstage?.pluginId,
    deps: Object.keys(pj.dependencies || {}),
  };
}
const withPluginId = Object.values(info).filter(i => i.pluginId).length;
console.log('packages with pluginId:', withPluginId, '/', roles.length);

const roleRules = [
  { s: ['frontend-plugin', 'web-library'], t: ['backend-plugin', 'node-library', 'backend-plugin-module', 'frontend-plugin'] },
  { s: ['backend-plugin', 'node-library', 'backend-plugin-module'], t: ['frontend-plugin', 'web-library', 'backend-plugin'] },
  { s: ['common-library'], t: ['frontend-plugin', 'web-library', 'backend-plugin', 'node-library', 'backend-plugin-module'] },
];
const excluded = new Set([
  '@backstage/plugin-catalog', '@backstage/plugin-techdocs', '@backstage/plugin-app',
  '@backstage/plugin-catalog-backend', '@backstage/test-utils', '@backstage/plugin-auth-backend',
  '@backstage/plugin-permission-backend', '@backstage/plugin-kubernetes-backend',
  '@backstage/config-loader', '@backstage/plugin-app-backend',
]);

let edges = 0, crossRoleMatrixHits = 0;
let violations = [], ffExempt = [], excludedHits = [], sameRoleCellHits = [];
for (const [src, si] of Object.entries(info)) {
  for (const dep of si.deps) {
    const ti = info[dep];
    if (!ti) continue; // external or non-role-tagged
    edges++;
    const hit = roleRules.some(r => r.s.includes(si.role) && r.t.includes(ti.role));
    if (!hit) continue;
    crossRoleMatrixHits++;
    const rec = { src, dst: dep, sr: si.role, tr: ti.role };
    // pluginId exemption: ONLY frontend-plugin -> frontend-plugin with equal pluginId
    if (si.role === 'frontend-plugin' && ti.role === 'frontend-plugin' && si.pluginId && ti.pluginId && si.pluginId === ti.pluginId) {
      ffExempt.push(rec); continue;
    }
    if (excluded.has(dep)) { excludedHits.push(rec); continue; }
    if (si.role === ti.role) sameRoleCellHits.push(rec);
    violations.push(rec);
  }
}
console.log('\nintra-repo declared-dep edges between role-tagged pkgs:', edges);
console.log('edges hitting the deny matrix:', crossRoleMatrixHits);
console.log('  exempted by same-pluginId FF->FF:', ffExempt.length);
console.log('  suppressed by excludedTargetPackages:', excludedHits.length);
console.log('  remaining live violations:', violations.length);
console.log('    of which same-role cells (inexpressible as cross-component deny):', sameRoleCellHits.length);

console.log('\n-- FF->FF pluginId-exempt edges (align would FP on these if it COULD express the cell):');
for (const e of ffExempt) console.log('  ', e.src, '->', e.dst);
console.log('\n-- excluded (baselined debt) edges:');
for (const e of excludedHits) console.log('  ', e.src, '->', e.dst, `(${e.sr}->${e.tr})`);
console.log('\n-- live violations:');
for (const e of violations) console.log('  ', e.src, '->', e.dst, `(${e.sr}->${e.tr})`);

// Cell breakdown of matrix hits
const cells = {};
for (const arr of [violations, ffExempt, excludedHits]) for (const e of arr) { const k = `${e.sr} -> ${e.tr}`; cells[k] = (cells[k]||0)+1; }
console.log('\ncell breakdown of all matrix hits:');
for (const [k,v] of Object.entries(cells).sort((a,b)=>b[1]-a[1])) console.log('  ', k, v);
