import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.ts';
import type { PackageJson, PnpmLockfile } from './types.ts';

export function readJson<T>(absPath: string): T | undefined {
  if (!existsSync(absPath)) return undefined;
  try {
    return JSON.parse(readFileSync(absPath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function readPackageJson(repoRoot: string, importerRelPath: string): PackageJson | undefined {
  const p = path.join(repoRoot, importerRelPath, 'package.json');
  return readJson<PackageJson>(p);
}

export function readLockfile(repoRoot: string): PnpmLockfile | undefined {
  const p = path.join(repoRoot, 'pnpm-lock.yaml');
  if (!existsSync(p)) return undefined;
  const raw = readFileSync(p, 'utf8');
  return parseYaml(raw) as PnpmLockfile;
}

/**
 * Walk a pnpm-managed node_modules/.pnpm content-addressable store and return
 * every distinct installed package.json found under it, deduped by
 * name@version. This is the offline "which packages are actually installed"
 * census — used for install-script detection.
 *
 * pnpm's .pnpm layout: node_modules/.pnpm/<name>@<version>[_peerHash]/node_modules/<name>/package.json
 * (scoped packages: node_modules/.pnpm/@scope+name@version/node_modules/@scope/name/package.json)
 */
export interface InstalledPackage {
  key: string; // the .pnpm directory entry name (name@version[_peerhash])
  manifestPath: string;
  manifest: PackageJson;
}

export function listInstalledPackages(repoRoot: string): InstalledPackage[] {
  const pnpmDir = path.join(repoRoot, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return [];

  const out: InstalledPackage[] = [];
  const entries = readdirSync(pnpmDir);
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const entryDir = path.join(pnpmDir, entry);
    let st;
    try {
      st = statSync(entryDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const nmDir = path.join(entryDir, 'node_modules');
    if (!existsSync(nmDir)) continue;

    // The installed package itself lives at node_modules/<name>/package.json
    // (or node_modules/@scope/<name>/package.json). Find it by walking the
    // one or two levels pnpm uses, skipping the `.bin` directory and any
    // *other* hoisted deps that also get symlinked in for resolution.
    for (const child of readdirSync(nmDir)) {
      if (child === '.bin' || child === '.modules.yaml') continue;
      const childPath = path.join(nmDir, child);
      let childStat;
      try {
        childStat = statSync(childPath);
      } catch {
        continue;
      }
      if (!childStat.isDirectory()) continue;

      if (child.startsWith('@')) {
        // scoped: one more level down
        for (const scopedChild of readdirSync(childPath)) {
          const manifestPath = path.join(childPath, scopedChild, 'package.json');
          const manifest = readJson<PackageJson>(manifestPath);
          if (manifest) {
            out.push({ key: `${entry}::${child}/${scopedChild}`, manifestPath, manifest });
          }
        }
      } else {
        const manifestPath = path.join(childPath, 'package.json');
        const manifest = readJson<PackageJson>(manifestPath);
        if (manifest) {
          out.push({ key: `${entry}::${child}`, manifestPath, manifest });
        }
      }
    }
  }
  return out;
}

/** Dedup installed packages by name@version (the .pnpm dir already mostly does this,
 *  but the same version can appear under multiple peer-hash variants). */
export function dedupeByNameVersion(pkgs: InstalledPackage[]): InstalledPackage[] {
  const seen = new Map<string, InstalledPackage>();
  for (const p of pkgs) {
    const nv = `${p.manifest.name ?? '?'}@${p.manifest.version ?? '?'}`;
    if (!seen.has(nv)) seen.set(nv, p);
  }
  return [...seen.values()];
}
