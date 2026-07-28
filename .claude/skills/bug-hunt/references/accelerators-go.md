# Accelerator Pack: Go

Candidates only — classify in Step 4. Use `glob="**/*.go"`, exclude `vendor/`, `_test.go`.

## Lens 1 — Assumptions

```
Grep pattern="_\s*=\s*\w+\("                       # explicitly discarded errors/values
Grep pattern="\[0\]"                               # non-empty slice assumptions
Grep pattern="\.\(\*?\w+\)"                        # type assertion without ,ok form → panic
Grep pattern="\w+\[\w+\]$"                         # map read without ,ok (zero value ambiguity)
Grep pattern="os\.Getenv"                          # empty-string returns treated as present
Grep pattern="MustCompile|Must\w+\("               # Must* in request paths, not just init
```

## Lens 2 — State Machines

```
Grep pattern="state\s+\w+|Status\s+string|iota"    # enumerate states; find dead ends
Grep pattern="ctx\.Done\(\)|ctx\.Err\(\)"          # find loops/selects that DON'T check cancellation
Grep pattern="sync\.Once|atomic\."
```

## Lens 3 — Boundaries

```
Grep pattern="len\(\w+\)\s*-\s*\d"                 # index arithmetic; len==0
Grep pattern="\[\w+:\w*\]"                         # slice expressions — bounds panics
Grep pattern="int8|int16|int32|uint8\(|uint16\(|uint32\("   # narrowing conversions truncate silently
Grep pattern="binary\.(Big|Little)Endian"          # fixed-width reads on variable-width data
Grep pattern="strconv\.Atoi|ParseInt"              # range/error handling
```

## Lens 4 — Data Lifecycle

```
Grep pattern="DELETE FROM|\.Delete\(|Exec\("
Grep pattern="INSERT INTO|\.Create\(|\.Save\("
Grep pattern="Begin\(\)|BeginTx|Tx\b"              # multi-statement writes without a transaction
Grep pattern="defer .*Close\(\)"                   # or its absence after Open
Grep pattern="ILIKE|LIKE '%"                       # see SQL pack
```

## Lens 5 — Error Paths

```
Grep pattern="if err != nil" -A 2                  # returns that drop context; log-only branches
Grep pattern="err = \w+\(" 
Grep pattern="err :=" -A 1                         # shadowed err — inner err checked, outer intended
Grep pattern="go func\("                           # goroutine panics crash the process; errors dropped
                                                   # unless routed via channel/errgroup
Grep pattern="recover\(\)"
Grep pattern="errors\.Is|errors\.As"               # vs string-matching on err.Error()
```

## Lens 6 — Time & Concurrency

```
Grep pattern="time\.Now\(\)"                       # wall clock vs monotonic; timezone assumptions
Grep pattern="time\.Parse\(|Format\("
Grep pattern="Exists\(" -A 5                       # TOCTOU: check-then-insert
Grep pattern="go func" -B 3                        # loop-variable capture (pre-1.22), shared-state races
Grep pattern="sync\.Mutex|RWMutex"                 # find shared maps/slices mutated WITHOUT one
Grep pattern="time\.Sleep"                         # sleeps as synchronization
```

## Lens 7 — Environment Divergence

```
Grep pattern="runtime\.GOOS|runtime\.GOARCH"
Grep pattern="build\s+\w+|//go:build"              # build tags — which variant is less tested?
Grep pattern="os\.Getenv"                          # per-deploy semantics
Grep pattern="GOMAXPROCS|NumCPU"
```

## Lens 8 — Cross-Implementation Divergence

```
Grep pattern="type \w+ interface" -A 10            # list interfaces, then every implementor
Grep pattern="func \(\w+ \*?\w+\) <MethodName>\("  # each implementation of a shared method →
                                                   # build the guard matrix (impl × guard-at-file:line)
```
Also compare: gRPC server vs client wrappers; v1/v2 packages; per-backend storage drivers.

## Lens 9 — Write/Read Asymmetry

```
Grep pattern="strings\.ToLower|ToUpper|TrimSpace|norm\."   # canonicalization inventory
Grep pattern="Where\(|Query\(|QueryRow\("          # read sites per field
Grep pattern="INSERT|Update\(|Set\("               # write sites per field
Grep pattern="fmt\.Sprintf\(\".*%s"                # derived keys (cache/limiter) — same normalization?
```

## Empirical harness

```bash
cat > /tmp/probe.go <<'EOF'
package main
import "fmt"
func main() {
    // e.g. narrowing truncation:
    var x int64 = 1 << 32
    fmt.Println(uint32(x)) // 0 — silent wrap
}
EOF
go run /tmp/probe.go
```
