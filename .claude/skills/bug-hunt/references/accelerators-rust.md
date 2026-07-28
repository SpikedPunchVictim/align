# Accelerator Pack: Rust

Candidates only — classify in Step 4. Use `glob="**/*.rs"`, exclude `target/`, generated code.
Note: many candidate patterns are *idiomatic and fine* in Rust (e.g. `unwrap` in tests/main); the
lens question is always whether the failure path is acceptable *at that call site*.

## Lens 1 — Assumptions

```
Grep pattern="\.unwrap\(\)"                        # panic paths in library/request code
Grep pattern="\.expect\("                          # same, with a message — is panic acceptable here?
Grep pattern="\[0\]"                               # index panics on empty slices
Grep pattern="unsafe"                              # every block: what invariant justifies it?
Grep pattern="env::var\(.*\)\.unwrap"
Grep pattern="\.unwrap_or_default\(\)"             # masks absence with a zero value — is that right?
```

## Lens 2 — State Machines

```
Grep pattern="enum \w+ \{" -A 10                   # map transition sets
Grep pattern="match .* \{" -A 10                    # catch-all `_ =>` arms hiding new variants
Grep pattern="Mutex|RwLock" -A 3                    # lock().unwrap() — poisoned-lock policy?
Grep pattern="tokio::select!|\.abort\(\)"           # cancellation: partially-completed state
```

## Lens 3 — Boundaries

```
Grep pattern="as u(8|16|32)|as i(8|16|32)"         # `as` casts truncate silently
Grep pattern="\.len\(\)\s*-\s*\d"                  # underflow panics (debug) / wraps (release) on usize
Grep pattern="checked_|wrapping_|saturating_"      # inventory — find arithmetic NOT using them
Grep pattern="from_be_bytes|from_le_bytes|try_into\(\)\.unwrap"   # fixed-width reads
Grep pattern="\.get\(\d+\)|\.get_unchecked"
Grep pattern="chars\(\)|as_bytes\(\)"              # byte-vs-char indexing; slicing non-boundary panics
```

## Lens 4 — Data Lifecycle

```
Grep pattern="DELETE FROM|\.delete\(|execute\("
Grep pattern="INSERT INTO|\.insert\(|\.save\("
Grep pattern="begin\(\)|transaction"               # multi-statement writes without one
Grep pattern="Drop for|mem::forget|Box::leak"      # cleanup paths that can be skipped
```

## Lens 5 — Error Paths

```
Grep pattern="let _ = "                            # discarded Results
Grep pattern="\.ok\(\);|\.ok\(\)$"                 # error → None, information dropped
Grep pattern="map_err\(|\.or_else\("               # error translation that loses cause
Grep pattern="tokio::spawn\("                      # JoinHandle dropped → panics/errors vanish
Grep pattern="\.await\?;" -B 3                     # early ? returns leaving partial state
Grep pattern="panic!|unreachable!|todo!|unimplemented!"
```

## Lens 6 — Time & Concurrency

```
Grep pattern="SystemTime::now|Utc::now|Local::now" # wall clock; Local vs Utc mixing
Grep pattern="Instant::now"                        # ok for durations — mixing with SystemTime isn't
Grep pattern="exists\(" -A 5                       # TOCTOU: check-then-insert
Grep pattern="Arc<Mutex|Arc<RwLock"                # lock ordering; await while holding a lock
Grep pattern="sleep\("                             # sleeps as synchronization
```

## Lens 7 — Environment Divergence

```
Grep pattern="cfg!\(|#\[cfg\("                     # conditional compilation — less-tested branch?
Grep pattern="target_os|target_arch|target_endian"
Grep pattern="std::env::var"                       # per-deploy semantics
```

## Lens 8 — Cross-Implementation Divergence

```
Grep pattern="trait \w+ \{" -A 10                  # list traits, then every `impl Trait for`
Grep pattern="impl \w+ for \w+"                    # each implementation of a shared method →
                                                   # build the guard matrix (impl × guard-at-file:line)
```
Also compare: sync and async variants; per-backend feature-gated impls (`#[cfg(feature = ...)]`).

## Lens 9 — Write/Read Asymmetry

```
Grep pattern="to_lowercase\(|to_ascii_lowercase\(|trim\(\)|nfc\(\)|nfkc\(\)"   # canonicalization inventory
Grep pattern="filter\(|query\(|find\("             # read sites per field
Grep pattern="insert\(|set\(|bind\("               # write sites per field
Grep pattern="format!\(\".*\{\}"                   # derived keys — same normalization as storage?
```

## Empirical harness

```bash
cat > /tmp/probe.rs <<'EOF'
fn main() {
    // e.g. `as` truncation:
    let x: u64 = 1 << 32;
    println!("{}", x as u32); // 0 — silent
}
EOF
rustc -O /tmp/probe.rs -o /tmp/probe && /tmp/probe
```
