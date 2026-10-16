/**
 * API Authentication Middleware
 * 
 * Provides authentication verification for all sensitive API routes.
 * Three authentication methods supported:
 * 
 * 1. INTERNAL_API_SECRET — for server-to-server / cron / internal calls
 * 2. Wallet signature — for user-initiated operations (EIP-191)
 * 3. CRON_SECRET — legacy cron authentication (via QStash or Bearer)
 * 
 * SECURITY: This is the ONLY gateway to sensitive operations.
 * Every mutation endpoint MUST call one of these verifiers.
 */

import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { ethers } from 'ethers';
import { logger } from '@/lib/utils/logger';

// ─── Timing-safe string comparison ──────────────────────────────────
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Timing-safe `Authorization: Bearer <secret>` check.
 *
 * Reads the `Authorization` header, accepts `Bearer <secret>` only when
 * `secret` matches one of the provided env-var values via constant-time
 * comparison. Returns `false` for missing headers and missing env vars.
 *
 * Usage:
 *   if (!verifyAdminBearer(request, ['ADMIN_SECRET', 'CRON_SECRET'])) {
 *     return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 *   }
 */
export function verifyAdminBearer(
  request: NextRequest,
  envVarNames: string[],
): boolean {
  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  for (const name of envVarNames) {
    const secret = (process.env[name] || '').trim();
    if (secret && timingSafeEqual(token, secret)) return true;
  }
  return false;
}

// ─── 1. Internal Service Authentication ─────────────────────────────
/**
 * Verify that a request comes from an internal service (cron, orchestrator, etc.)
 * Checks Authorization: Bearer <INTERNAL_API_SECRET> header.
 */
export function verifyInternalAuth(request: NextRequest): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[Auth] INTERNAL_API_SECRET not configured in production — denying');
      return false;
    }
    // Dev mode: warn but allow
    logger.warn('[Auth] INTERNAL_API_SECRET not configured — allowing in dev mode');
    return true;
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;

  const token = authHeader.slice(7);
  return timingSafeEqual(token, secret);
}

// ─── 2. Wallet Signature Authentication ─────────────────────────────
/**
 * Verify that a request was signed by the claimed wallet address.
 * Expects headers:
 *   x-wallet-address: <address>
 *   x-wallet-signature: <signature>
 *   x-wallet-message: <message> — must start with "ZKward ", name the wallet
 *     ("Wallet: <address>") and carry "timestamp:<unix seconds>" within 5 min.
 *     A signature made for another site, another wallet or long ago is refused.
 * 
 * Or body fields: walletAddress, signature, signedMessage
 */
export async function verifyWalletAuth(
  request: NextRequest,
  body?: Record<string, unknown>
): Promise<{ authenticated: boolean; walletAddress?: string }> {
  const walletAddress = (
    request.headers.get('x-wallet-address') ||
    (body?.walletAddress as string)
  )?.toLowerCase();

  const signature = (
    request.headers.get('x-wallet-signature') ||
    (body?.signature as string)
  );

  // Message from header is base64-encoded (to avoid newline issues in HTTP headers)
  // Message from body is plain text
  const rawMessage = request.headers.get('x-wallet-message');
  let message: string | undefined;
  
  if (rawMessage) {
    try {
      // Decode base64-encoded header value
      message = Buffer.from(rawMessage, 'base64').toString('utf-8');
    } catch {
      // Fallback: try as plain text (for backwards compatibility)
      message = rawMessage;
    }
  } else {
    message = body?.signedMessage as string;
  }

  if (!walletAddress || !signature || !message) {
    return { authenticated: false };
  }

  const problem = walletMessageProblem(message, walletAddress, Math.floor(Date.now() / 1000));
  if (problem) {
    logger.warn('[Auth] Wallet message refused', { walletAddress, problem });
    return { authenticated: false };
  }

  try {

    const recoveredAddress = ethers.verifyMessage(message, signature).toLowerCase();
    if (recoveredAddress === walletAddress) {
      return { authenticated: true, walletAddress: recoveredAddress };
    }

    logger.warn('[Auth] Wallet signature mismatch', {
      claimed: walletAddress,
      recovered: recoveredAddress,
    });
    return { authenticated: false };
  } catch (error) {
    logger.warn('[Auth] Wallet signature verification failed', {
      walletAddress,
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return { authenticated: false };
  }
}

/** Null when a signed message may authenticate `walletAddress` at `nowSec`, else why not. */
export function walletMessageProblem(message: string, walletAddress: string, nowSec: number): string | null {
  if (!message.startsWith('ZKward ')) return 'not a ZKward message';
  const wallet = message.match(/^Wallet: (\S+)$/m)?.[1];
  if (!wallet || wallet.toLowerCase() !== walletAddress.toLowerCase()) return 'message names another wallet';
  const ts = message.match(/^timestamp:(\d+)$/m)?.[1];
  if (!ts) return 'no timestamp';
  if (Math.abs(nowSec - Number(ts)) > 300) return 'expired';
  return null;
}

// ─── 3. Combined Auth Check ─────────────────────────────────────────
/**
 * Check if a request is authenticated via ANY supported method.
 * Returns the auth method and identity if authenticated.
 */
export async function verifyAuth(
  request: NextRequest,
  body?: Record<string, unknown>
): Promise<{
  authenticated: boolean;
  method?: 'internal' | 'wallet' | 'system';
  identity?: string;
}> {
  // Method 1: Internal service token
  if (verifyInternalAuth(request)) {
    return { authenticated: true, method: 'internal', identity: 'service' };
  }

  // Method 2: System secret in body (legacy cron compatibility)
  const systemSecret = body?.systemSecret as string;
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (systemSecret && cronSecret && timingSafeEqual(systemSecret, cronSecret)) {
    return { authenticated: true, method: 'system', identity: 'cron' };
  }

  // Method 3: Wallet signature
  const walletResult = await verifyWalletAuth(request, body);
  if (walletResult.authenticated) {
    return { authenticated: true, method: 'wallet', identity: walletResult.walletAddress };
  }

  return { authenticated: false };
}

// ─── 4. Helper: Require Auth or Return 401 ──────────────────────────
/**
 * Convenience wrapper — returns a 401 response if not authenticated.
 * Usage in route handlers:
 * 
 *   const authResult = await requireAuth(request, body);
 *   if (authResult instanceof NextResponse) return authResult;
 *   // authResult is { method, identity }
 */
export async function requireAuth(
  request: NextRequest,
  body?: Record<string, unknown>
): Promise<
  | NextResponse
  | { method: 'internal' | 'wallet' | 'system'; identity: string }
> {
  const result = await verifyAuth(request, body);
  if (!result.authenticated) {
    logger.warn('[Auth] Unauthorized request', {
      path: request.nextUrl.pathname,
      ip: request.headers.get('x-forwarded-for') || 'unknown',
    });
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }
  return { method: result.method!, identity: result.identity! };
}

// ─── 5. Require Admin Auth (internal only) ──────────────────────────
export function requireAdminAuth(request: NextRequest): NextResponse | true {
  if (!verifyInternalAuth(request)) {
    return NextResponse.json(
      { success: false, error: 'Admin authentication required' },
      { status: 401 }
    );
  }
  return true;
}
