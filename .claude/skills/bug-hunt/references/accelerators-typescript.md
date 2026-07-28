# Accelerator Pack: TypeScript / JavaScript / Node

Greps generate **candidates only** — classification happens in SKILL.md Step 4. Use
`glob="**/*.{ts,tsx,js,jsx,mjs,cjs}"` and exclude `node_modules`, `dist`, `*.d.ts`, test dirs.

## Lens 1 — Assumptions

```
Grep pattern="\w!\."                              # non-null assertion chains
Grep pattern="as unknown as|as any"               # type-system escape hatches
Grep pattern="\[0\]|\.shift\(\)|\.pop\(\)"        # non-empty-collection assumptions
Grep pattern="JSON\.parse\("                      # unguarded parse of external data
Grep pattern="process\.env\.\w+[!\)]"             # env var assumed present
Grep pattern="\.split\([^)]*\)\[\d"               # split result indexed without length check
```

## Lens 2 — State Machines

```
Grep pattern="isLoading|isProcessing|isSaving|isPending|inProgress"
Grep pattern="useState\(.*true\)|useState\(.*false\)"
Grep pattern="status\s*[:=]\s*['\"]"              # string status fields — map the transition set
Grep pattern="AbortController|signal\.aborted"    # find what does NOT handle abortion
```

## Lens 3 — Boundaries

```
Grep pattern="\.push\(\.\.\."                     # spread into call — V8 stack limit on big inputs
Grep pattern="apply\(null|Math\.max\(\.\.\.|Math\.min\(\.\.\."
Grep pattern="read(U?Int|Big(U?Int)?|Float|Double)\w*\("   # fixed-width reads on variable-width buffers
Grep pattern="\.length\s*-\s*\d"                  # index arithmetic; check zero-length
Grep pattern="parseInt\([^,)]*\)"                 # missing radix
Grep pattern="\.slice\(|\.substring\(|\.subarray\("
Grep pattern="\.replace\(/\[\^"                   # allowlist strips — can produce empty string
```

## Lens 4 — Data Lifecycle

```
Grep pattern="deleteFrom|\.delete\(|DELETE FROM|destroy\("
Grep pattern="insertInto|\.insert\(|INSERT INTO|\.save\(|\.create\("
Grep pattern="transaction"                        # then find multi-statement writes WITHOUT it
Grep pattern="ilike|ILIKE|like\b|LIKE '%"         # pattern-match where equality was meant (see SQL pack)
Grep pattern="onDelete|cascade|ON DELETE"         # or its absence for FK-less schemas
```

## Lens 5 — Error Paths

```
Grep pattern="catch\s*(\([^)]*\))?\s*\{\s*\}"     # empty catch
Grep pattern="catch" -A 3                          # catches that only console.log
Grep pattern="\.then\([^)]*\)\s*$"                 # promise chain without .catch
Grep pattern="void\s+[a-zA-Z_$][\w$]*\("           # fire-and-forget async
Grep pattern="from ['\"]node:stream['\"]"          # callback pipeline/finished misused under await —
                                                   # callback-form pipeline returns the DEST STREAM,
                                                   # so `await pipeline(...)` resolves instantly and
                                                   # try/catch never fires; errors become unhandled
                                                   # 'error' events that can kill the process.
                                                   # Correct form imports from 'node:stream/promises'.
Grep pattern="new EventEmitter|\.on\('error'"      # emitters vs missing error listeners
Grep pattern="try\s*\{\s*return await"             # fine — but check the non-await returns nearby
```

## Lens 6 — Time & Concurrency

```
Grep pattern="new Date\(|Date\.now\(\)"
Grep pattern="toLocale(Lower|Upper)Case|toLocaleString|toLocaleDate"   # locale-dependent folding on
                                                   # identity/protocol strings (Turkish-ı hazard)
Grep pattern="setTimeout|setInterval|debounce|throttle"
Grep pattern="[eE]xists\(" -A 5                    # check-then-act TOCTOU: exists() then insert()
Grep pattern="rate.?limit|RateLimit" -B 2 -A 2     # inspect the KEY construction — raw vs normalized input
Grep pattern="retry|backoff"                       # retries without idempotency keys
```

## Lens 7 — Environment Divergence

```
Grep pattern="process\.platform|process\.version|os\.platform"
Grep pattern="process\.env\."                      # semantics that change per deploy
Grep pattern="typeof window|typeof document|globalThis"   # Node-vs-browser splits
Grep pattern="Intl\.|navigator\.language"
Grep pattern="featureFlag|FEATURE_|flags\."
```

## Lens 8 — Cross-Implementation Divergence

```
Grep pattern="implements\s+\w+"                    # list implementors of each interface
Glob  pattern="**/stores/*/src/**"                 # per-backend store layouts (adjust to repo shape)
Grep pattern="<methodName>\(" glob="**/*.ts"       # for each shared method: read EVERY implementation,
                                                   # build the guard matrix (impl × guard-at-file:line)
```
Also compare: SDK vs server for the same operation; client-side vs server-side validation of the
same field; v1 vs v2 modules that coexist.

## Lens 9 — Write/Read Asymmetry

For each stored/keyed field, grep BOTH sides and diff the normalization:

```
Grep pattern="toLowerCase\(|toLocaleLowerCase\(|trim\(|normalize\("   # inventory canonicalizations
Grep pattern="where\(['\"]<field>|\.eq\(['\"]<field>"                 # read sites for that field
Grep pattern="<field>:\s|set\(['\"]<field>|insert" -B 2 -A 2          # write sites for that field
Grep pattern="`\$\{|cacheKey|dedupe|limiterKey"                       # derived keys built from the field
```

## Empirical harness (Step 4.6 / Step 6.8)

Run in the scratchpad; paste command + output into the finding.

```bash
# threshold / stack-limit checks
node -e 'for (const n of [16384,65536,131072,262144]) { try { const a=[]; a.push(...Buffer.alloc(n).values()); console.log(n,"OK") } catch(e){ console.log(n,"THROWS:",e.constructor.name) } }'

# buffer read boundary checks (fix verification)
node -e 'const b=Buffer.alloc(7); try { console.log(b.readBigUInt64BE(b.length-8)) } catch(e){ console.log("THROWS:",e.message) }'

# regex acceptance table
node -e 'const re=/^PATTERN$/; for (const s of ["", "a", "==", "…"]) console.log(JSON.stringify(s), re.test(s))'

# locale folding
node -e 'console.log("I".toLocaleLowerCase("tr-TR"), "I".toLowerCase())'
```
