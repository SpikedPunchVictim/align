/**
 * Node emits a `MODULE_TYPELESS_PACKAGE_JSON` warning when it strip-and-loads an ESM
 * `align.config.ts` from a target repo whose `package.json` has no `"type"` field (very common). It
 * is a benign performance note about that one config load — align itself is the only thing that
 * triggers it in this process — so this filter drops that specific warning code process-wide and
 * re-emits every other warning untouched.
 *
 * Rejected alternatives: adding `"type": "module"` to the user's `package.json` would change how ALL
 * of their `.js` files are interpreted and could break a CommonJS project (not align's call to
 * make); writing `align.config.mts` is the standard fix but spreads a conditional config filename
 * through init/build/export-ir — suppressing one benign warning is the smaller, reversible change.
 */

const SUPPRESSED_WARNING_CODES: ReadonlySet<string> = new Set(['MODULE_TYPELESS_PACKAGE_JSON']);

/** Pure: whether a given process warning should be swallowed rather than printed. */
export function isSuppressedWarning(warning: { readonly code?: string }): boolean {
  return warning.code !== undefined && SUPPRESSED_WARNING_CODES.has(warning.code);
}

/**
 * Installs a process-wide 'warning' filter (permanently — never restored, so there is no async race
 * with a warning Node emits on a later tick than the import that provoked it). Node's existing
 * default listener is captured and re-invoked for every non-suppressed warning, so real warnings
 * print exactly as before; when no default listener is present yet, we replicate it (stderr).
 */
export function installWarningFilter(): void {
  const priorListeners = process.listeners('warning') as Array<(w: Error) => void>;
  process.removeAllListeners('warning');
  process.on('warning', (warning: Error & { code?: string }): void => {
    if (isSuppressedWarning(warning)) return;
    if (priorListeners.length > 0) {
      for (const listener of priorListeners) listener(warning);
    } else {
      process.stderr.write(`${warning.name}: ${warning.message}\n`);
    }
  });
}
