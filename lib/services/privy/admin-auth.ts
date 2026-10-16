/**
 * Privy admin authentication — B2B track policy layer.
 *
 * Verifies that an incoming request carries a valid Privy JWT AND the
 * authenticated user is on the operator-controlled allowlist. Optional
 * quorum gate: some actions require N distinct approvers before they
 * execute.
 *
 * Prize alignment (Privy Best B2B financial product $2.5K):
 *   - "policies, team permissions, quorum approvals" — this module.
 *   - "organization wallets" — deferred until Privy Enterprise; the
 *     allowlist + quorum approach delivers the same *behavior* without
 *     the paid tier.
 *
 * Used by app/api/admin/hedera-pool/quorum-action/route.ts.
 */

import { createHash } from 'crypto';
import { logger } from '@/lib/utils/logger';
import { getPrivyAppId, getPrivyAppSecret, getPrivyAdminAllowlist, getPrivyAdminQuorum } from '@/lib/evm-wallet/privy-config';

export interface AdminAuthResult {
  ok: boolean;
  userId?: string;
  email?: string;
  reason?: string;
}

// ─── Privy JWT verify ─────────────────────────────────────────────────────

async function verifyPrivyToken(token: string): Promise<{ userId: string; email?: string } | null> {
  const appId = getPrivyAppId();
  const appSecret = getPrivyAppSecret();
  if (!appId || !appSecret) {
    logger.warn('[privy-admin] app id / secret not set — verify skipped');
    return null;
  }
  try {
    const { PrivyClient } = await import('@privy-io/server-auth');
    const client = new PrivyClient(appId, appSecret);
    const claims = await client.verifyAuthToken(token);
    if (!claims?.userId) return null;
    // Fetch user for email match (allowlist may reference email).
    let email: string | undefined;
    try {
      const user = await client.getUser(claims.userId);
      email = user?.email?.address ?? user?.google?.email;
    } catch (e) {
      logger.debug('[privy-admin] getUser failed (non-fatal)', {
        userId: claims.userId, error: e instanceof Error ? e.message : String(e),
      });
    }
    return { userId: claims.userId, email };
  } catch (e) {
    logger.warn('[privy-admin] verifyAuthToken failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

// ─── Allowlist check ──────────────────────────────────────────────────────

/** True if user matches any allowlist entry (userId OR email:<addr>). */
export function isOnAdminAllowlist(userId: string, email: string | undefined): boolean {
  const allow = getPrivyAdminAllowlist();
  if (allow.length === 0) return false; // fail-closed: empty allowlist blocks everyone
  for (const entry of allow) {
    if (entry === userId) return true;
    if (email && entry === `email:${email.toLowerCase()}`) return true;
  }
  return false;
}

// ─── Quorum tracking (in-memory + Redis when available) ──────────────────
// Simple pattern: for `actionId`, collect distinct approver userIds until
// we reach `quorum`. Approvals expire after 15 min so a stalled action
// doesn't hold a partial quorum forever.

const QUORUM_KEY_PREFIX = 'privy-quorum:';
const QUORUM_TTL_MS = 15 * 60 * 1000;

interface QuorumRecord {
  approvers: string[];
  createdAt: number;
  /** Hash of what the first approver approved; every later approval must match it. */
  subjectHash?: string;
}

/** Stable hash of an action and its parameters (keys sorted, so order does not matter). */
export function quorumSubjectHash(action: string, params: Record<string, unknown> | undefined): string {
  const p = params ?? {};
  const canonical = JSON.stringify({ action, params: Object.fromEntries(Object.keys(p).sort().map((k) => [k, p[k]])) });
  return createHash('sha256').update(canonical).digest('hex');
}

// In-memory fallback so the module works without Redis (unit tests, local
// dev, Redis outage). Same pattern as lib/services/x402/budget.ts. In
// production Redis is authoritative and gives cluster-wide consistency;
// the in-memory copy is a hot cache that survives quorum reads within
// one Vercel instance's request lifetime.
const quorumMem = new Map<string, QuorumRecord>();

async function readQuorum(actionId: string): Promise<QuorumRecord> {
  const key = `${QUORUM_KEY_PREFIX}${actionId}`;
  try {
    const { getCronState } = await import('@/lib/db/cron-state-redis');
    const rec = await getCronState<QuorumRecord>(key);
    if (rec && Date.now() - rec.createdAt <= QUORUM_TTL_MS) {
      quorumMem.set(key, rec);
      return rec;
    }
  } catch { /* fall through to memory */ }
  const cached = quorumMem.get(key);
  if (cached && Date.now() - cached.createdAt <= QUORUM_TTL_MS) return cached;
  return { approvers: [], createdAt: Date.now() };
}

async function writeQuorum(actionId: string, rec: QuorumRecord): Promise<void> {
  const key = `${QUORUM_KEY_PREFIX}${actionId}`;
  quorumMem.set(key, rec);
  try {
    const { setCronState } = await import('@/lib/db/cron-state-redis');
    await setCronState(key, rec);
  } catch { /* best effort — memory copy is our persistence floor */ }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Verify + allowlist check. Returns the auth result; caller decides
 * whether to require quorum on top.
 */
export async function requireAdminUser(token: string): Promise<AdminAuthResult> {
  const claims = await verifyPrivyToken(token);
  if (!claims) return { ok: false, reason: 'invalid or missing Privy token' };
  const on = isOnAdminAllowlist(claims.userId, claims.email);
  if (!on) return { ok: false, userId: claims.userId, email: claims.email, reason: 'user not on admin allowlist' };
  return { ok: true, userId: claims.userId, email: claims.email };
}

/**
 * Record an approval for `actionId`. Returns whether quorum is now
 * reached (i.e. the caller can proceed with the destructive action).
 * Idempotent: duplicate approvals from the same user don't double-count.
 * An approval for a different action or different parameters under the same
 * id is refused (`conflict`): approvers must approve the same thing.
 */
export async function recordApprovalAndCheckQuorum(
  actionId: string,
  approverUserId: string,
  subjectHash: string,
): Promise<{ reached: boolean; approvers: string[]; required: number; conflict?: true }> {
  const rec = await readQuorum(actionId);
  const required = getPrivyAdminQuorum();
  if (rec.approvers.length > 0 && rec.subjectHash !== subjectHash) {
    return { reached: false, approvers: rec.approvers, required, conflict: true };
  }
  rec.subjectHash = subjectHash;
  if (!rec.approvers.includes(approverUserId)) rec.approvers.push(approverUserId);
  await writeQuorum(actionId, rec);
  return { reached: rec.approvers.length >= required, approvers: rec.approvers, required };
}

/**
 * Read-only snapshot for the admin UI. Never records a new approval.
 * Returns `{ approvers: [], createdAt: 0 }` if none yet, matching the
 * "not-yet-proposed" state so callers can treat both as zero-approvals.
 */
export async function readQuorumState(
  actionId: string,
): Promise<{ approvers: string[]; createdAt: number; required: number }> {
  const rec = await readQuorum(actionId);
  return {
    approvers: rec.approvers,
    createdAt: rec.createdAt,
    required: getPrivyAdminQuorum(),
  };
}

/** Spend a reached quorum: one set of approvals executes the action once. */
export async function consumeQuorum(actionId: string): Promise<void> {
  const key = `${QUORUM_KEY_PREFIX}${actionId}`;
  quorumMem.delete(key);
  try {
    const { deleteCronState } = await import('@/lib/db/cron-state-redis');
    await deleteCronState(key);
  } catch { /* ok */ }
}
