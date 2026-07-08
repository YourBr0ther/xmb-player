// api/src/http/auth.ts
import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time bearer-token check. Fails closed: an empty configured token
 * (misconfiguration) denies everything rather than authenticating all callers.
 */
export function tokenMatches(provided: string, expected: string): boolean {
  if (!expected) return false; // unconfigured => deny all
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
