// Normalization — ADR 025 §"Capture and normalization": "the part most likely to be got wrong."
//
// Two normalization strategies, deliberately different:
//
//   1. STRUCTURED (`.align/*.json`, `align.config.ts`'s rendered JSON-shaped bits): walk the
//      parsed value and blank out fields by KEY NAME from a fixed, small allowlist
//      (`VOLATILE_JSON_KEYS`). This is the safer of the two — it can only ever mask the exact
//      fields named, never anything else, so it cannot accidentally swallow a real diff in a
//      field nobody thought to name.
//   2. TEXT (stdout/stderr, and any raw file with no JSON structure to key off — CLAUDE.md, the
//      human-printed `align check` output): regex substitution. Riskier by construction — a
//      pattern that's too broad masks real diffs; too narrow leaves noise that makes every run
//      look different. Each pattern below documents, at the point of definition, what a
//      too-broad version of it would hide.
//
// Every rule is documented with what it normalizes and — the part ADR 025 explicitly asks for —
// what getting it wrong would MASK. Read this file before trusting a byte-identical diff.

const PLACEHOLDER_TIMESTAMP = '<normalized-timestamp>';
const PLACEHOLDER_DURATION = '<normalized-duration>';
const PLACEHOLDER_REPO = '<repo>';
const PLACEHOLDER_VERSION = '<normalized-version>';

/**
 * Structured JSON keys whose VALUE is normalized wherever the key appears, anywhere in the
 * object tree, regardless of which artifact it came from (`.align/baseline.json`'s
 * `acceptedAt`, `.align/ruleset-ir.json`'s `exportedAt`, `.align/rules.lock.json`'s `builtAt`,
 * `.align/generated-rules.json`'s `generatedAt`, a `--json` payload's `scannedAt`).
 *
 * MASKS: a real behavioral change that happens to also change how a timestamp is computed (e.g.
 * a regression that stamps `acceptedAt` on the WRONG entry, but the wrong entry's stamp still
 * gets blanked the same as the right one would have). This is why the harness's baseline
 * "unchanged" assertions compare `fingerprint`/`ruleId`/`file`/`acceptedBy` — the fields this
 * list deliberately does NOT touch — never the whole entry as an opaque blob.
 */
const VOLATILE_JSON_KEYS = new Set(['acceptedAt', 'exportedAt', 'builtAt', 'generatedAt', 'scannedAt']);

/**
 * Regex normalization applied to free text (stdout/stderr, CLAUDE.md, and any raw non-JSON
 * artifact). Order matters: absolute-path normalization must run before duration normalization,
 * because a path can itself contain digit sequences that a careless duration pattern might eat.
 */
const TEXT_RULES = [
  {
    name: 'absolute-path-to-repo-relative',
    description:
      "Replaces every occurrence of the working copy's absolute filesystem path (and its " +
      'macOS `/private/...` realpath variant, since `os.tmpdir()` resolves through a symlink ' +
      'there) with `<repo>`, so two runs against working copies at different tmp paths diff as ' +
      'identical.',
    masks:
      'A regression that leaks an absolute path from a DIFFERENT tree than the one under test ' +
      "(e.g. a bug that reads the harness's own checkout instead of the scenario's working copy) " +
      "would still normalize away IF that path happens to share the working copy's prefix — it " +
      "wouldn't for genuinely unrelated paths, which is the common case this is built to survive.",
    apply(text, ctx) {
      let out = text;
      for (const root of ctx.absolutePathVariants) {
        if (root.length === 0) continue;
        out = out.split(root).join(PLACEHOLDER_REPO);
      }
      return out;
    },
  },
  {
    name: 'wall-clock-durations',
    description:
      'Replaces number-plus-unit duration tokens (`123ms`, `1.4s`, `(0.8s)`) with ' +
      '`<normalized-duration>`. align\'s `--json` payloads never carry timing fields (ADR 007 ' +
      'payload discipline strips them); this rule exists for human-readable output and future ' +
      'commands (`telemetry`, `doctor`) that do print latency numbers.',
    masks:
      'Any genuine count that happens to be immediately followed by a bare "s" or "ms" — e.g. a ' +
      'component or file NAMED with a trailing "ms" segment. None of align\'s own output does ' +
      'this today; if a future message did, this rule would need a word-boundary exception.',
    apply(text) {
      return text.replace(/\b\d+(\.\d+)?\s?(ms|s|sec|seconds|milliseconds)\b/g, PLACEHOLDER_DURATION);
    },
  },
  {
    name: 'iso-timestamps',
    description:
      'Replaces ISO-8601 timestamps in free text (e.g. `align baseline show`\'s ' +
      '`accepted 2026-08-08T...`) with `<normalized-timestamp>`.',
    masks:
      'A regression that prints the right SHAPE of timestamp but the wrong VALUE (off-by-one-day, ' +
      'wrong timezone) — shape-only text normalization cannot distinguish "correct timestamp" from ' +
      '"wrong but plausible timestamp". Assertions that care about a specific accepted-at value ' +
      'must read the structured JSON field, not the human text.',
    apply(text) {
      return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, PLACEHOLDER_TIMESTAMP);
    },
  },
];

/**
 * Exact-version substrings normalized in free text when `keepVersion` is false. Deliberately a
 * literal list, not a semver regex — a semver-shaped regex would also eat every OTHER version
 * number a scenario legitimately prints (a violation count, a line number, a nest package
 * version like `11.1.26` embedded in a scanned file path) and that is exactly the "wrong
 * direction" failure ADR 025 warns about ("wrong in the other [direction] and real regressions
 * are hidden"). Confined to align's own five published versions plus the literal string `local`.
 */
const KNOWN_ALIGN_VERSIONS = ['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4'];

/**
 * MASKS (version normalization specifically): every scenario in increment 1 is version-agnostic
 * — none of them assert "the installed align identifies itself as X". A scenario that DOES care
 * (a future version-skew or `align docs`/`align skill` cross-version comparison scenario, ADR 025
 * §7 table) must request `keepVersion: true` on its capture calls, or this rule would normalize
 * away the exact signal being tested.
 */
function normalizeVersionInText(text) {
  let out = text;
  for (const v of KNOWN_ALIGN_VERSIONS) out = out.split(v).join(PLACEHOLDER_VERSION);
  return out;
}

/** Normalizes one string of free text: absolute paths, then durations, then ISO timestamps, then
 * (optionally) known align version strings. */
export function normalizeText(text, ctx) {
  let out = text;
  for (const rule of TEXT_RULES) out = rule.apply(out, ctx);
  if (!ctx.keepVersion) out = normalizeVersionInText(out);
  return out;
}

/**
 * Normalizes a parsed JSON value in place (returns a new value; never mutates `value`). Walks
 * arrays and objects; for object keys in `VOLATILE_JSON_KEYS`, replaces the value outright
 * (regardless of type — epoch-ms number or ISO string, both observed across align's artifacts)
 * with the timestamp placeholder. Every string value anywhere in the tree — not just the volatile
 * keys — also goes through `normalizeText`'s absolute-path/duration/version passes, since an
 * absolute path can appear as a violation's `file` field or inside `errorMessage` prose, not just
 * under a key this function otherwise recognizes.
 */
export function normalizeJson(value, ctx) {
  if (Array.isArray(value)) return value.map((v) => normalizeJson(v, ctx));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (VOLATILE_JSON_KEYS.has(key)) {
        out[key] = PLACEHOLDER_TIMESTAMP;
        continue;
      }
      out[key] = normalizeJson(v, ctx);
    }
    return out;
  }
  if (typeof value === 'string') return normalizeText(value, ctx);
  return value;
}

/** Builds the normalization context (the absolute-path variants to strip) for a given working
 * copy. macOS resolves `os.tmpdir()` through a `/var` -> `/private/var` symlink, so both the
 * logical and the realpath'd form of the working directory must be stripped — only stripping one
 * leaves the other as a spurious per-run diff. */
export function makeNormalizeContext(workingDir, realWorkingDir, keepVersion = false) {
  const variants = new Set([workingDir, realWorkingDir].filter(Boolean));
  return { absolutePathVariants: [...variants], keepVersion };
}

/** The rule catalog, exported for `README.md`/reporting to render without duplicating prose. */
export const NORMALIZATION_CATALOG = [
  {
    name: 'volatile-json-keys',
    keys: [...VOLATILE_JSON_KEYS],
    description: 'Structured JSON fields blanked by key name: acceptedAt, exportedAt, builtAt, generatedAt, scannedAt.',
    masks:
      'Only ever masks the named fields\' own values — never a sibling field. A regression that ' +
      'stamps the wrong ENTRY (right shape, wrong target) is not masked, since fingerprint/ruleId/' +
      'file/acceptedBy on that entry are compared unnormalized.',
  },
  ...TEXT_RULES.map((r) => ({ name: r.name, description: r.description, masks: r.masks })),
  {
    name: 'known-align-versions',
    description: 'Replaces the five published align version strings (0.1.0–0.1.4) with a placeholder in free text, unless a capture explicitly requests keepVersion: true.',
    masks:
      'Version-agnostic by default. A scenario asserting ON the installed version must opt out ' +
      'via keepVersion — none of the increment-1 scenarios do.',
  },
];
