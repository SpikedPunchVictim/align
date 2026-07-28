# Fix Verification — Why Each Check Exists

Load this before writing any fix. Each check in SKILL.md Step 6 exists because a real audit shipped
a defective fix that the check would have caught. The cases below are genericized from an actual
post-review of an audit run: three of the audit's proposed fixes were themselves broken.

A fix that ships a new bug is worse than a finding with no fix — it carries the auditor's implied
"I checked this," so it gets *less* scrutiny downstream, not more.

---

## Case 1: The guard that had the bug it guarded against
*(motivates checks 1 and 5 — boundary-test the fix's arithmetic; the fix must not reintroduce its own bug class)*

**Finding:** a crypto primitive silently truncated an oversized counter to its low N bytes,
restarting a nonce sequence — catastrophic, silent.

**Proposed fix (defective):** refuse oversized counters by parsing the high bytes with a
fixed-width read:

```
value = buf.readBigUInt64BE(buf.length - 8)   // "read the top 8 bytes"
```

Two defects, both found only in review:
- A **7-byte** input computes `readBigUInt64BE(-1)` → `RangeError`. The guard crashes on an input
  the original code handled.
- A **9-byte** input reads only the low 8 bytes. A 9-byte value of exactly 2^64 has low-8-bytes
  all-zero, **passes the guard, and truncates to zero** — the exact nonce reuse the guard exists
  to prevent.

**Correct shape:** a *total* construction — scan every byte above the low N and reject if any is
nonzero. No offsets, no fixed widths, correct for every input length by construction.

**Rule:** when a fix does arithmetic on lengths, offsets, or widths, evaluate it at 0, 1,
boundary−1, boundary, boundary+1, and at least one input longer than any width the fix assumes.
Prefer constructions that are total over all input sizes to fixed-width parses.

---

## Case 2: The one-sided normalization fix
*(motivates checks 2 and 3 — mirror-path; existing-data)*

**Finding:** a lookup queried a raw value against a column that the create path stored normalized
(lowercased). Real users could not be found.

**Proposed fix (incomplete):** normalize in the lookup. Correct as far as it goes — but:

- **The write path had the same hole.** A second save/update code path stored the raw value, so
  mixed-case rows could still be *written*. The read-side fix alone leaves the system able to
  recreate the bug forever.
- **Bad rows already existed.** The unique constraint was case-sensitive, so `John@x.com` and
  `john@x.com` could already coexist. The complete fix needed: (a) read-path normalization,
  (b) write-path normalization, (c) a data migration lowercasing existing rows — which can
  **collide with the unique constraint** on existing duplicate pairs and therefore needs a dedup
  plan *before* it can run, and (d) only then, a functional unique index on the normalized value
  to enforce the invariant in the database.

**Rule:** a normalization fix is four things, not one: read path + write path + migration (with a
collision plan) + database-level enforcement. Report all four or mark the fix
`requires design work`. Always ask: *what data already exists in the bad state?*

---

## Case 3: The guard with the wrong threshold
*(motivates check 4 — read the constraint from source)*

**Finding:** a derived identifier could come out empty and fail downstream.

**Proposed fix (defective):** `if (value.length === 0) fallback()`.

The downstream constraint was not "non-empty" — it was a **2-character minimum**, defined in a
validator module the fix's author never opened. A 1-character value passed the new guard and failed
downstream exactly as before. The fix looked complete and covered only part of the input space.

**Rule:** never encode an assumed constraint. Open the validator/schema/migration that defines the
real constraint, cite its file:line in the fix's comment, and guard against the *actual* rule
(`< 2`, the real charset, the real maximum).

---

## Case 4: The fix that arms a dormant bug
*(motivates check 6 — interactions)*

In the same audit, a rate limiter keyed on the raw form of a value was harmless — *because* the
lookup bug (Case 2) meant varied-case requests found no account and did nothing. **Fixing the
lookup made the limiter hole live:** every case variant would then resolve to a real account and
send a real email — an email-bombing path opened by shipping fix A without fix B.

Separately, two findings on the same table each "needed a migration" — the correct output is **one
shared migration**, stated once in the Fix Plan, not two conflicting ones.

**Rule:** after drafting all fixes, do a pairwise pass: does fix A change the conditions under
which finding/fix B matters? Does any pair share a migration or a deploy-ordering constraint?
Every interaction goes in the report's Fix Plan as a `ships-with` or `order` constraint.

---

## Case 5: The fix that changes the caller contract
*(motivates check 7)*

Switching an async API from a callback form (misused under `await`) to its promise form was the
right fix — but it changed *when* the function resolves (after the stream drains rather than
immediately) and *what* it returns. Every caller consuming the return value needed checking.
The fix was still right; shipping it without the caller sweep would not have been.

**Rule:** if the fix changes timing, return type, or throw behavior, grep every caller and state
in the finding which ones tolerate it and which need changes.

---

## The empirical re-test (check 8)

If the bug was confirmed by running code (e.g., "input of 131072 throws, 65536 doesn't"), rerun
the identical harness against the fixed logic and paste the output into the finding. A fix whose
finding was empirical but whose verification is theoretical is only half done.
