# Bug Hunt Report Template

Write the report to `.agents/research/YYYY-MM-DD-bug-hunt-<scope>.md` and display the same content
inline. One table format everywhere — never render a compact variant, never check terminal width.

```markdown
# Bug Hunt Report: [Scope Description]

**Date:** YYYY-MM-DD
**Scope:** [files/features analyzed; how candidates were prioritized]
**Lenses Applied:** [list]
**Runtime context:** [Step 0.4 answer; any directories excluded as dead/generated]
**Files read in full:** N — [list if <= ~20]

## Guard Map

Guard locations consulted during verification and refutation (Step 2):

- migrations: [paths]
- API/input schemas: [paths]
- validation modules: [paths]
- middleware/guards: [paths]
- config defaults/limits: [paths]
- sibling implementations: [paths]

## Summary

| Status | Count |
|--------|-------|
| Bugs Found | X |
| Fragile Code | Y |
| OK (Already Guarded) | Z |
| Needs Review | W |
| Killed in Refutation | K |

## Issue Rating Table

All BUG and FRAGILE findings, sorted by Urgency then ROI.

| # | Finding | Lens | Confidence | Urgency | Risk: Fix | Risk: No Fix | ROI | Blast Radius | Fix Effort |
|---|---------|------|-----------|---------|-----------|--------------|-----|--------------|------------|
| 1 | file.ts:45 — [one-line claim] | Boundary | Confirmed (empirical) | 🔴 Critical | ⚪ Low | 🔴 Critical | 🟠 Excellent | 1 file | Trivial |
| 2 | store.ts:401 — [one-line claim] | Write/Read | Traced | 🔴 Critical | 🟡 High | 🔴 Critical | 🟠 Excellent | 2 files + migration (collision risk) | Medium |

Scales:
- **Confidence:** Confirmed (empirical) · Traced · (Suspected items appear only under Needs Review)
- **Urgency:** 🔴 CRITICAL (crash/data loss/security) · 🟡 HIGH (incorrect behavior) · 🟢 MEDIUM (degraded) · ⚪ LOW (cosmetic)
- **Risk: Fix:** regression risk of the fix (⚪ isolated · 🟡 shared paths / contract or timing change · 🔴 needs migration or coordination)
- **Risk: No Fix:** consequence if left unfixed
- **ROI:** 🟠 Excellent · 🟢 Good · 🟡 Marginal · 🔴 Poor
- **Blast Radius (three axes, all stated):** `N files` [+ `migration` | `migration (collision risk)`] [+ `cross-service` | `contract change`]
- **Fix Effort:** Trivial / Small / Medium / Large / requires design work

## Fix Plan & Interactions

The section to read before acting on anything above.

**Ships-with sets** (never split across phases):
- #2 + F6 — [why: e.g., fixing #2 alone activates the rate-limit hole in F6]

**Ordering constraints:**
- #3 before F5 — [why]

**Shared migrations** (write once):
- #2 + #8 — one `users` migration: [normalize step, dedup/collision plan, then functional unique index]

**Deferred to design work:**
- #6 — [which Step 6 checks failed and why]

**Suggested phases:**
1. Phase 1 — [findings, files, migration if any]
2. Phase 2 — ...

## Detailed Findings

### 1. `path/file.ext:line` — [Brief description]
**Lens:** [lens]
**Confidence:** Confirmed (empirical) | Traced — [evidence: exact command + output, or clause-by-clause trace citations]
**Assumption:** [what the code assumes]
**Violation scenario:** [how a real user/operator/attacker triggers it]
**Consequence:** [what actually happens — as verified in Step 5, not the first-draft claim]

**Current code:**
```lang
// problematic code
```

**Verified fix** (passed all 8 Step 6 checks) — or **Fix: requires design work — [failed checks]:**
```lang
// corrected code, with constraint citations in comments (file:line)
```
**Fix notes:** [mirror-path status, existing-data/migration status, caller-contract impact, interactions]

## Fragile Code (Works Now, May Break Later)

### F1. `path/file.ext:line` — [Brief description]
**Lens / Confidence / Current behavior / Breaking scenario (name the specific foreseeable change) / Recommendation**

## Already Guarded (Reference)

Candidates cleared by verification — cite the guard:
- `file.ext:123` — guarded by `guards/validator.ext:45` [what the guard does]

## Refutation Log

Findings and sub-claims killed or corrected in Step 5 — kept to show coverage and prevent re-flagging:
- [claim] — **Refuted** by `migrations/001_x.sql:32` (unique constraint on `user`)
- [claim] — **Corrected:** stated mechanism was [X]; actual mechanism is [Y]; severity moved [A]→[B]

## Needs Human Review

Including all Suspected-confidence items:
- `file.ext:456` — [what's unclear, what evidence would settle it]
```
