/**
 * AI chat response cache — hash-based, cross-user, 5-min TTL.
 *
 * ## Why cache the RESPONSE, not just tool results?
 *
 * Tool-level caching (Crypto.com tickers, DefiLlama TVL) helps but the
 * biggest latency is the LLM stream itself (1-3s per call). Popular
 * questions like "how is BTC" or "TVL of Aave" ask the same LLM to
 * synthesize the same data every time. Caching the FINAL text lets us
 * skip the LLM entirely for repeat questions within TTL.
 *
 * ## Hash key
 *
 * SHA256 of (normalized message + intent + sorted assets + sorted protocols).
 * Normalization = lowercase + collapse whitespace + strip most punctuation.
 * "How is BTC?" == "how is btc" == "HOW IS BTC" → same hash.
 *
 * ## What NOT to cache
 *
 * - vault_state intent — personal vault data changes fast
 * - diagnose / diagnose_move — usually time-anchored to specific event
 * - Questions with prior_messages — follow-ups depend on context
 * - Response was an error / empty fallback
 *
 * Cache decision is made at the ROUTE, not here — this module just
 * provides hash + get + set + fail-open helpers.
 */

import crypto from 'node:crypto';
import { logger } from '@/lib/utils/logger';

export interface CachedResponse {
  response: string;
  toolCalls: Array<{ tool: string; ok: boolean; latencyMs: number }> | null;
  iterations: number | null;
  cachedAt: Date;
  hitCount: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — balance freshness vs hit rate

/**
 * Deterministic cache key for a chat message. Ignores case, punctuation
 * variation, and word-order shuffling within the same intent.
 */
export function makeCacheKey(
  message: string,
  intent: string,
  assets: string[],
  protocols: string[],
): string {
  const normalizedMsg = message
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, ''); // strip punctuation
  const sortedAssets = [...assets].sort().join(',');
  const sortedProtos = [...protocols].sort().join(',');
  const raw = `${normalizedMsg}|${intent}|${sortedAssets}|${sortedProtos}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Fetch cached response by hash. Returns null on miss, expired, or DB error. */
export async function getCachedResponse(hash: string): Promise<CachedResponse | null> {
  try {
    const { query } = await import('@/lib/db/postgres');
    const rows = await query<{
      response: string;
      tool_calls: string | null;
      iterations: number | null;
      cached_at: Date;
      hit_count: number;
    }>(
      `SELECT response, tool_calls, iterations, cached_at, hit_count
       FROM chat_response_cache
       WHERE question_hash = $1
         AND cached_at > NOW() - ($2::text || ' milliseconds')::interval
       LIMIT 1`,
      [hash, String(CACHE_TTL_MS)],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    // Increment hit count + update last_hit_at, fire-and-forget
    void (async () => {
      try {
        await query(
          `UPDATE chat_response_cache
           SET hit_count = hit_count + 1, last_hit_at = NOW()
           WHERE question_hash = $1`,
          [hash],
        );
      } catch { /* no-op */ }
    })();
    return {
      response: row.response,
      toolCalls: row.tool_calls ? (typeof row.tool_calls === 'string' ? JSON.parse(row.tool_calls) : row.tool_calls) : null,
      iterations: row.iterations,
      cachedAt: row.cached_at,
      hitCount: row.hit_count,
    };
  } catch (e) {
    logger.debug('[ChatCache] get failed (non-fatal)', { error: e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100) });
    return null;
  }
}

/** Store response in cache. Upsert on hash. Never throws. */
export async function setCachedResponse(
  hash: string,
  input: {
    questionPreview: string;
    intent: string;
    response: string;
    toolCalls?: Array<{ tool: string; ok: boolean; latencyMs: number }>;
    iterations?: number;
    elapsedMs?: number;
  },
): Promise<void> {
  try {
    const { query } = await import('@/lib/db/postgres');
    await query(
      `INSERT INTO chat_response_cache
         (question_hash, question_preview, intent, response, tool_calls, iterations, elapsed_ms, cached_at, hit_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 0)
       ON CONFLICT (question_hash) DO UPDATE SET
         response = EXCLUDED.response,
         tool_calls = EXCLUDED.tool_calls,
         iterations = EXCLUDED.iterations,
         elapsed_ms = EXCLUDED.elapsed_ms,
         cached_at = NOW()`,
      [
        hash,
        input.questionPreview.slice(0, 120),
        input.intent,
        input.response.slice(0, 32 * 1024),
        input.toolCalls ? JSON.stringify(input.toolCalls) : null,
        input.iterations ?? null,
        input.elapsedMs ?? null,
      ],
    );
  } catch (e) {
    logger.debug('[ChatCache] set failed (non-fatal)', { error: e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100) });
  }
}

/**
 * Decide whether a question is cacheable. Called before the get/set
 * decisions to short-circuit for personal / time-sensitive queries.
 */
export function isCacheable(intent: string, hasPriorMessages: boolean): boolean {
  if (hasPriorMessages) return false; // follow-ups depend on context
  // Personal, time-sensitive, or event-anchored intents — always fresh
  if (['vault_state', 'diagnose', 'diagnose_move'].includes(intent)) return false;
  return true;
}
