# Accelerator Pack: Swift (iOS / macOS / server-side)

Candidates only — classify in Step 4. Use `glob="**/*.swift"`, exclude test targets and previews.

For Apple-platform projects, Step 0.4's runtime question maps to platform conditionals: code inside
`#if os(X)` where X is not in the shipping set is OK (excluded by build), not BUG.

## Lens 1 — Assumptions

```
Grep pattern="\.first!|\.last!"
Grep pattern="\[0\]"
Grep pattern="as!"
Grep pattern="try!"
Grep pattern="\.removeFirst\(\)|\.removeLast\(\)"
Grep pattern="UserDefaults.*\)!"
```

## Lens 2 — State Machines

```
Grep pattern="@State.*=.*(true|false)"
Grep pattern="@Published.*=.*(true|false)"
Grep pattern="isLoading|isProcessing|isSaving|isAnalyzing"
Grep pattern="showingError|showingAlert|showingSheet"
Grep pattern="Task\s*\{" -A 5                      # view-teardown vs in-flight Task; cancellation handling
```

## Lens 3 — Boundaries

```
Grep pattern="\.remove(First|Last)\(\)"
Grep pattern="\.prefix\(|\.suffix\("
Grep pattern="\.split\(|\.components\("
Grep pattern="Int\.max|\.count\s*-\s*1"
Grep pattern="String\(.*utf8|unicodeScalars"       # grapheme-vs-scalar counting; emoji/RTL
```

## Lens 4 — Data Lifecycle

```
Grep pattern="context\.insert\(|context\.delete\(|context\.save\("
Grep pattern="\.deleteRule\s*="
Grep pattern="@Query"
Grep pattern="CloudKit|CKRecord|sync"              # conflict policy present?
```

## Lens 5 — Error Paths

```
Grep pattern="try\?"                               # error → nil information loss
Grep pattern="catch\s*\{" -A 3                     # log-only catches; missing isLoading reset
Grep pattern="guard let.*else\s*\{\s*return\s*\}"  # silent abort of a user action
Grep pattern="Task\s*\{" -A 5                      # unhandled errors vanish
```

## Lens 6 — Time & Concurrency

```
Grep pattern="DateFormatter\(\)"                   # no explicit timezone/locale
Grep pattern="Date\(\)|timeIntervalSince"
Grep pattern="\.debounce|\.throttle"               # or their absence on submit actions
Grep pattern="URLSession"                          # timeouts; offline path
```

## Lens 7 — Environment Divergence

```
Grep pattern="#if os\("                            # logic not mirrored in #else
Grep pattern="#available\("                        # empty/incomplete else branches
Grep pattern="UIScreen\.main|UIDevice\.current"
Grep pattern="CIContext|MTLDevice|MTLCreateSystemDefaultDevice"   # GPU assumptions
Grep pattern="LAContext|biometry"                  # Face ID assumed; could be Touch ID or none
```

## Lens 8 — Cross-Implementation Divergence

```
Grep pattern="protocol \w+" -A 10                  # list protocols, then every conformer
Grep pattern="func <methodName>\("                 # each conformance of a shared requirement →
                                                   # build the guard matrix (impl × guard-at-file:line)
```
Also compare: iOS vs macOS branches of the same feature; widget/extension vs main app logic.

## Lens 9 — Write/Read Asymmetry

```
Grep pattern="lowercased\(\)|uppercased\(\)|trimmingCharacters|folding\("   # canonicalization inventory
Grep pattern="#Predicate|NSPredicate|fetchRequest"  # read sites — normalization applied?
Grep pattern="\.setValue|encode\(|insert\("         # write sites
Grep pattern="cacheKey|forKey:"                     # derived keys — same normalization as storage?
```

## Empirical harness

```bash
swift -e 'print("I".lowercased(with: Locale(identifier: "tr-TR")), "I".lowercased())'
swift -e 'let s = "👨‍👩‍👧‍👦"; print(s.count, s.unicodeScalars.count, s.utf8.count)'
```
