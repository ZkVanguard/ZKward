/**
 * AI chat logging — persist user + assistant turns to Bakchodi for
 * (a) operator visibility, (b) future RAG retrieval, (c) prompt iteration.
 *
 * Fire-and-forget: any DB failure logs a warning and no-ops. The chat UX
 * never blocks on persistence.
 *
 * Session ID is client-provided (UUID stored in localStorage). No user
 * auth involved. If the user clears their browser data, their session
 * resets and prior context is lost — by design.
 */

import { logger } from '@/lib/utils/logger';
import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_CAP_BYTES = 32 * 1024;
const RECENT_LOOKUP_LIMIT = 8;

const IP_HASH_SALT = (process.env.AI_CHAT_IP_HASH_SALT || 'default-ip-salt-2026').trim();

function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return crypto
    .createHash('sha256')
    .update(`${IP_HASH_SALT}:${ip}`)
    .digest('hex')
    .slice(0, 64);
}

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

export interface LogChatTurnInput {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ tool: string; ok: boolean; latencyMs: number }>;
  elapsedMs?: number;
  iterations?: number;
  finishedNormally?: boolean;
  userAgent?: string | null;
  clientIp?: string | null;
}

/** Fire-and-forget. Never throws. */
export async function logChatTurn(input: LogChatTurnInput): Promise<void> {
  if (!isValidSessionId(input.sessionId)) return;
  if (input.role !== 'user' && input.role !== 'assistant') return;
  if (!input.content) return;

  try {
    const { query } = await import('@/lib/db/postgres');
    await query(
      `INSERT INTO ai_chat_logs
         (session_id, role, content, tool_calls, elapsed_ms, iterations, finished_normally, user_agent, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.sessionId,
        input.role,
        input.content.slice(0, CONTENT_CAP_BYTES),
        input.toolCalls ? JSON.stringify(input.toolCalls) : null,
        input.elapsedMs ?? null,
        input.iterations ?? null,
        input.finishedNormally ?? null,
        (input.userAgent || '').slice(0, 200) || null,
        hashIp(input.clientIp),
      ],
    );
  } catch (e) {
    // Never fail the chat because logging failed
    logger.warn('[AIChatLogs] insert failed (non-fatal)', {
      error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    });
  }
}

/**
 * Fetch the last few turns for a session — used to enrich the LLM's
 * system prompt with prior context on multi-turn conversations. Returns
 * empty on any error so the chat still runs.
 *
 * Excludes the current tick's messages (caller passes only what was
 * persisted BEFORE this request).
 */
export async function loadRecentSessionContext(sessionId: string): Promise<
  Array<{ role: 'user' | 'assistant'; content: string; createdAt: Date }>
> {
  if (!isValidSessionId(sessionId)) return [];
  try {
    const { query } = await import('@/lib/db/postgres');
    const rows = await query<{ role: string; content: string; created_at: Date }>(
      `SELECT role, content, created_at
       FROM ai_chat_logs
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [sessionId, RECENT_LOOKUP_LIMIT],
    );
    // Return chronological
    return rows
      .reverse()
      .map((r) => ({
        role: r.role === 'user' ? 'user' : 'assistant',
        content: r.content,
        createdAt: r.created_at,
      })) as Array<{ role: 'user' | 'assistant'; content: string; createdAt: Date }>;
  } catch (e) {
    logger.warn('[AIChatLogs] recent-context load failed (non-fatal)', {
      error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    });
    return [];
  }
}
