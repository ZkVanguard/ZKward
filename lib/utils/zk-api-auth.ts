/**
 * Shared headers for calls to the Python ZK prover API.
 *
 * The prover is public at zk.zkward.com (2026-09-28) and enforces
 * X-Api-Key when its ZK_API_AUTH_HEADER env is set. Every TS call site
 * routes through this helper so the key is attached in one place;
 * without ZK_API_KEY set (local dev against an auth-less server) it
 * degrades to plain JSON headers.
 */
export function zkApiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = (process.env.ZK_API_KEY || '').trim();
  return {
    'Content-Type': 'application/json',
    ...(key ? { 'X-Api-Key': key } : {}),
    ...extra,
  };
}
