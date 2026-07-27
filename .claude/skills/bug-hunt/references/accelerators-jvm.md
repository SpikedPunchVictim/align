# Accelerator Pack: Java / Kotlin (JVM)

Candidates only — classify in Step 4. Use `glob="**/*.{java,kt,kts}"`, exclude `build/`, `target/`,
generated sources, tests.

## Lens 1 — Assumptions

```
Grep pattern="\.get\(0\)"                          # non-empty list assumptions
Grep pattern="\.get\(\)"                           # Optional.get() without isPresent
Grep pattern="!!"                                  # Kotlin not-null assertion
Grep pattern="\(String\)|\(Integer\)|as \w+[^?]"   # unchecked casts
Grep pattern="System\.getenv\("                    # null returns treated as present
Grep pattern="\.split\([^)]*\)\[\d"
Grep pattern="Objects\.requireNonNull"             # find params NOT covered by it
```

## Lens 2 — State Machines

```
Grep pattern="enum class|enum \w+ \{"              # map transition sets; dead-end members
Grep pattern="volatile|AtomicBoolean|isRunning|isActive"
Grep pattern="synchronized" -A 3                   # check-then-act split across two synchronized blocks
Grep pattern="CancellationException|isCancelled"   # coroutine/future cancellation handling
```

## Lens 3 — Boundaries

```
Grep pattern="\.length\(\)\s*-\s*\d|\.size\(\)\s*-\s*\d"
Grep pattern="\.substring\(|\.subList\("           # IndexOutOfBounds on short input
Grep pattern="\(int\)|\.toInt\(\)|intValue\(\)"    # narrowing; silent overflow wrap
Grep pattern="ByteBuffer\.|getLong\(|getInt\("     # fixed-width reads on variable-width data
Grep pattern="Integer\.parseInt|toIntOrNull"
Grep pattern="replaceAll\(\"\[\^"                  # allowlist strips — can yield empty string
```

## Lens 4 — Data Lifecycle

```
Grep pattern="DELETE FROM|deleteBy|\.delete\("
Grep pattern="INSERT INTO|\.save\(|\.persist\("
Grep pattern="@Transactional|beginTransaction"     # multi-statement writes without it
Grep pattern="CascadeType|orphanRemoval"           # or their absence
Grep pattern="ILIKE|LIKE '%|like\("                # see SQL pack
```

## Lens 5 — Error Paths

```
Grep pattern="catch\s*\([^)]*\)\s*\{\s*\}"         # empty catch
Grep pattern="catch" -A 3                           # log-only handlers; e.printStackTrace()
Grep pattern="throws Exception|catch \(Exception"   # over-broad
Grep pattern="CompletableFuture" -A 3               # missing exceptionally/whenComplete
Grep pattern="GlobalScope\.launch|launch \{"        # Kotlin fire-and-forget; exceptions vanish
Grep pattern="runCatching"                          # results never inspected
```

## Lens 6 — Time & Concurrency

```
Grep pattern="SimpleDateFormat"                    # not thread-safe AND locale-dependent
Grep pattern="new Date\(\)|System\.currentTimeMillis|LocalDateTime\.now"   # zone-naive now()
Grep pattern="\.toLowerCase\(\)|\.toUpperCase\(\)" # NO Locale arg = default-locale folding
                                                   # (Turkish-ı hazard on identity strings);
                                                   # correct form: toLowerCase(Locale.ROOT)
Grep pattern="existsBy|\.exists\(" -A 5            # TOCTOU: check-then-insert
Grep pattern="ConcurrentHashMap|HashMap"           # HashMap shared across threads
Grep pattern="Thread\.sleep"                       # sleeps as synchronization
```

## Lens 7 — Environment Divergence

```
Grep pattern="os\.name|System\.getProperty"
Grep pattern="file\.separator|line\.separator"     # hardcoded / and \n instead
Grep pattern="Charset\.defaultCharset|getBytes\(\)$"   # default-charset reads/writes
Grep pattern="Locale\.getDefault"
```

## Lens 8 — Cross-Implementation Divergence

```
Grep pattern="implements \w+|: \w+\(\)? \{"        # implementors per interface
Grep pattern="(override )?fun <methodName>\(|public .* <methodName>\("
                                                   # each implementation of a shared method →
                                                   # build the guard matrix (impl × guard-at-file:line)
```
Also compare: repository implementations per datastore; DTO validation client vs server; blocking
and reactive variants of the same service.

## Lens 9 — Write/Read Asymmetry

```
Grep pattern="toLowerCase|toUpperCase|trim\(\)|Normalizer\."   # canonicalization inventory
Grep pattern="findBy|where|createQuery"            # read sites per field — normalization applied?
Grep pattern="\.set\w+\(|@Column" -B 2 -A 2        # write sites per field
Grep pattern="cacheKey|key = |@Cacheable"          # derived keys — same normalization?
```

## Empirical harness

```bash
cat > /tmp/Probe.java <<'EOF'
public class Probe { public static void main(String[] a) {
    System.out.println("I".toLowerCase(new java.util.Locale("tr","TR")) + " vs " + "I".toLowerCase(java.util.Locale.ROOT));
}}
EOF
java /tmp/Probe.java

kotlin -e 'println(Int.MAX_VALUE + 1)'   # silent wrap
```
