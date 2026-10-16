/**
 * B2B admin action — policy + quorum gated via Privy.
 *
 * Demo endpoint for the Privy Best B2B financial product prize track
 * ($2.5K). Takes an authenticated Privy user, checks they're on the
 * admin allowlist, records their approval for a specific action id,
 * and executes only when the configured quorum is met.
 *
 * The concrete action-set is intentionally minimal for the hackathon
 * (raise TVL cap, pause pool, trigger fee sweep). Each maps to an
 * existing on-chain function on CommunityPool.sol; execution is
 * DELEGATED to the existing admin machinery — this route only
 * gate-keeps the authorization.
 *
 * Flow
 *   POST /api/admin/hedera-pool/quorum-action
 *     Headers: Authorization: Bearer <privy-jwt>
 *     Body:    { action: 'raise-tvl-cap', actionId: '<idempotency-key>',
 *                params: { newCapUsdc: 50000 } }
 *   Response
 *     202 → approval recorded; quorum not yet met (returns current count)
 *     200 → quorum met; action queued/executed
 *     401/403 → auth failure
 *
 * Env
 *   NEXT_PUBLIC_PRIVY_APP_ID   Privy app id (from privy.io dashboard)
 *   PRIVY_APP_SECRET           server-only secret
 *   PRIVY_ADMIN_ALLOWLIST      comma-separated userIds or `email:<addr>`
 *   PRIVY_ADMIN_QUORUM         approvals required (default 1)
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { readLimiter } from '@/lib/security/rate-limiter';
import { requireAdminUser, recordApprovalAndCheckQuorum, readQuorumState, quorumSubjectHash, consumeQuorum } from '@/lib/services/privy/admin-auth';
import { getPrivyAdminAllowlist, getPrivyAdminQuorum } from '@/lib/evm-wallet/privy-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// ─── Supported actions ─────────────────────────────────────────────────────

type AdminAction = 'raise-tvl-cap' | 'pause-pool' | 'unpause-pool' | 'sweep-fees';

interface ActionBody {
  action: AdminAction;
  actionId: string;                    // idempotency key — shared across approvers
  params?: Record<string, unknown>;
}

function isValidAction(v: unknown): v is AdminAction {
  return typeof v === 'string' && ['raise-tvl-cap', 'pause-pool', 'unpause-pool', 'sweep-fees'].includes(v);
}

// ─── GET: poll approval state for an actionId (public, read-only) ─────────
// The admin UI polls this to render "1/2 approvers" without needing to
// re-submit an approval. Returns the current approver count, the required
// threshold, and the allowlist size — everything the UI needs to render
// the quorum widget. No PII exposed (only counts + hashed userIds).

export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = readLimiter.check(request);
  if (limited) return limited;

  const actionId = request.nextUrl.searchParams.get('actionId') ?? '';
  if (!actionId) {
    // No specific action — return policy config only (for the "Policies" card).
    return NextResponse.json({
      policy: {
        allowlistSize: getPrivyAdminAllowlist().length,
        quorum: getPrivyAdminQuorum(),
      },
    });
  }

  const state = await readQuorumState(actionId);
  return NextResponse.json({
    actionId,
    approverCount: state.approvers.length,
    required: state.required,
    reached: state.approvers.length >= state.required,
    // Return truncated userIds so the UI can show "did:privy:abc…12" style
    // pills without leaking full ids in a shareable URL response.
    approvers: state.approvers.map((id) => id.length > 16 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id),
    createdAt: state.createdAt,
    policy: {
      allowlistSize: getPrivyAdminAllowlist().length,
      quorum: state.required,
    },
  });
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = readLimiter.check(request);
  if (limited) return limited;

  // 1. Extract Privy token.
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return NextResponse.json({ error: 'missing Privy Bearer token' }, { status: 401 });
  }

  // 2. Verify + allowlist.
  const auth = await requireAdminUser(token);
  if (!auth.ok) {
    logger.warn('[quorum-action] auth rejected', { reason: auth.reason, userId: auth.userId });
    return NextResponse.json(
      { error: auth.reason ?? 'unauthorized', userId: auth.userId },
      { status: 403 },
    );
  }

  // 3. Parse body.
  let body: ActionBody;
  try {
    body = (await request.json()) as ActionBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!isValidAction(body.action)) {
    return NextResponse.json({ error: `unknown action: ${body.action}` }, { status: 400 });
  }
  if (typeof body.actionId !== 'string' || body.actionId.length === 0) {
    return NextResponse.json({ error: 'actionId required' }, { status: 400 });
  }

  // 4. Record approval + check quorum.
  const quorum = await recordApprovalAndCheckQuorum(body.actionId, auth.userId!, quorumSubjectHash(body.action, body.params));
  if (quorum.conflict) {
    return NextResponse.json(
      { error: 'this action id is already being approved for a different action or parameters', actionId: body.actionId },
      { status: 409 },
    );
  }
  logger.info('[quorum-action] approval recorded', {
    action: body.action, actionId: body.actionId,
    userId: auth.userId, email: auth.email,
    approvers: quorum.approvers.length, required: quorum.required, reached: quorum.reached,
  });

  if (!quorum.reached) {
    return NextResponse.json({
      status: 'pending-approvals',
      action: body.action,
      actionId: body.actionId,
      approvers: quorum.approvers.length,
      required: quorum.required,
      remaining: quorum.required - quorum.approvers.length,
    }, { status: 202 });
  }

  // 5. Quorum reached — execute the downstream admin operation. The
  //    quorum layer authorised the caller; downstream endpoints use the
  //    operator's ADMIN_SECRET which we hold server-side, so no user
  //    secret ever leaks. Only raise-tvl-cap is wired for the demo; the
  //    other actions (pause / sweep) return a receipt without executing
  //    until their downstream endpoints exist.
  // Spent before executing: a retry or a second request cannot run it again on the same approvals.
  await consumeQuorum(body.actionId);
  const executed = await executeAction(body, request);

  return NextResponse.json({
    status: 'quorum-reached',
    action: body.action,
    actionId: body.actionId,
    approvers: quorum.approvers,
    executedAt: new Date().toISOString(),
    executed,
  }, { status: 200 });
}

// ─── Downstream dispatch ───────────────────────────────────────────────────
// Real execution happens by re-entering the operator-secret-gated admin
// routes. That keeps the two authorization layers cleanly separated:
//   • quorum-action: proves the human policy (Privy JWT + allowlist + N-of-M)
//   • sui-set-tvl-cap: proves possession of the operator secret

async function executeAction(
  body: ActionBody,
  request: NextRequest,
): Promise<{ ok: boolean; endpoint?: string; status?: number; response?: unknown; error?: string }> {
  const adminSecret = (process.env.ADMIN_SECRET || process.env.CRON_SECRET || '').trim();
  if (!adminSecret) {
    return { ok: false, error: 'server missing ADMIN_SECRET/CRON_SECRET — cannot execute' };
  }

  const origin = request.nextUrl.origin;

  try {
    if (body.action === 'raise-tvl-cap') {
      const capUsdc = Number((body.params as { newCapUsdc?: unknown })?.newCapUsdc);
      if (!Number.isFinite(capUsdc) || capUsdc <= 0) {
        return { ok: false, error: 'params.newCapUsdc required (positive number in human USDC)' };
      }
      const endpoint = `${origin}/api/admin/sui-set-tvl-cap`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ capUsdc }),
      });
      const response = await res.json().catch(() => ({}));
      return { ok: res.ok, endpoint, status: res.status, response };
    }
    return { ok: false, error: `action '${body.action}' has no downstream wired yet — quorum recorded but no-op` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
