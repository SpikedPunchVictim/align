// Matched `app/**/model.ts` under the pre-0.2.0 cross-segment `**` semantics (no path-segment
// boundary at all — the exact bug commit 6d6c9c1 fixed), and does not match under the current
// whole-segment semantics.
export const dataModel = {};
