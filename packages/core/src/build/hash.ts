import { createHash } from 'node:crypto';

/**
 * Generic content hash (hex, truncated to 16 chars — matches `computeFingerprint`'s length so
 * every content-addressed id in the system reads the same length). Used for markdown section
 * hashes (lockfile drift detection) and the generated-rules.json divergence hash — deliberately
 * NOT the same function as `computeFingerprint` (baseline/fingerprint.ts), which is a violation
 * fingerprint with its own semantics; this is a plain content hash with no domain meaning beyond
 * "did these bytes change."
 */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}
