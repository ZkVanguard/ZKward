import { Pool, PoolClient } from 'pg';
import { logger } from '@/lib/utils/logger';

// PostgreSQL connection pool
let pool: Pool | null = null;

// Pool metrics for monitoring
const _poolMetrics = { queries: 0, errors: 0, slowQueries: 0 };

export function getPoolMetrics() {
  const p = pool;
  return {
    ..._poolMetrics,
    totalConnections: p?.totalCount ?? 0,
    idleConnections: p?.idleCount ?? 0,
    waitingClients: p?.waitingCount ?? 0,
  };
}

export function getPool(): Pool {
  if (!pool) {
    // Prefer DATABASE_POOL_URL (PgBouncer / Neon pooler) for high concurrency,
    // fall back to DATABASE_URL (direct connection).
    let connectionString =
      process.env.DATABASE_POOL_URL ||
      process.env.DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/zkward';

    // 2026-09-23: stale DATABASE_POOL_URL pointing at the retired Aiven DB
    // silently routed every query to a dead endpoint. The AI-interpretation
    // load in PredictionAggregatorService swallowed the failure at `debug`
    // level so nothing paged — AI signals silently vanished from the
    // aggregator for weeks. Warn loudly if both vars are set and point at
    // different hosts, so the next drift surfaces immediately.
    const poolUrl = process.env.DATABASE_POOL_URL;
    const directUrl = process.env.DATABASE_URL;
    if (poolUrl && directUrl) {
      const poolHost = poolUrl.match(/@([^:/]+)/)?.[1];
      const directHost = directUrl.match(/@([^:/]+)/)?.[1];
      if (poolHost && directHost && poolHost !== directHost) {
        logger.warn('[postgres] DATABASE_POOL_URL and DATABASE_URL point at different hosts', {
          component: 'postgres',
          poolHost,
          directHost,
          chose: poolHost,
        });
      }
    }

    // Remove channel_binding parameter if present (not supported by pg module)
    connectionString = connectionString.replace(/&?channel_binding=[^&]*/g, '').replace('?&', '?');

    const isNeon = connectionString.includes('neon.tech');

    // Ensure sslmode=verify-full for Neon (replaces require/prefer modes)
    if (isNeon) {
      connectionString = connectionString.replace(
        /sslmode=require|sslmode=prefer/g,
        'sslmode=verify-full'
      );
      if (!connectionString.includes('sslmode=')) {
        connectionString += (connectionString.includes('?') ? '&' : '?') + 'sslmode=verify-full';
      }
    }

    const requiresSsl =
      isNeon || /sslmode=(require|verify-full|verify-ca)/.test(connectionString);
    const isPooler =
      connectionString.includes(':6543') ||
      connectionString.includes(':6432') ||
      connectionString.includes('-pooler.');

    // Loopback tunnels (cloudflared, ssh -L) present the DB cert at 127.0.0.1
    // — hostname assertion fails because the cert's CN is the real endpoint.
    // Chain verification is still enforced; MITM is not a concern on loopback
    // (traffic never leaves the machine before entering an encrypted tunnel).
    // Anything else — including production pg.zkward.com — gets strict verify.
    const isLoopback = /@(?:127\.0\.0\.1|localhost)[:/]/.test(connectionString);

    // Strip sslmode from the URL so pg-connection-string's implicit "require
    // aliases to verify-full" behavior doesn't override the explicit ssl
    // option below. Neon keeps its sslmode= because we want its verify-full
    // path there.
    if (requiresSsl && !isNeon) {
      connectionString = connectionString
        .replace(/([?&])sslmode=[^&]+/g, '$1')
        .replace(/[?&]$/, '');
    }

    pool = new Pool({
      connectionString,
      ssl: requiresSsl
        ? isLoopback
          ? { rejectUnauthorized: false }
          : { rejectUnauthorized: true }
        : undefined,
      max: isPooler ? 25 : isNeon ? 8 : 20,
      min: isNeon ? 1 : 2,
      idleTimeoutMillis: isNeon ? 8000 : 20000,
      // 3000ms was too tight for Bakchodi's Cloudflare-tunneled PG which
      // flaps intermittently (verified 2026-09-21: multiple sessions timed
      // out mid-query, dropped the AI chat's postmortem tool at exactly
      // 3002ms). 8s tolerates a slow tunnel handshake while still failing
      // fast when the server is truly down. Neon (managed) keeps 5s.
      connectionTimeoutMillis: isNeon ? 5000 : 8000,
      // statement_timeout deliberately not passed here — pg would send it as a
      // libpq startup parameter, which PgBouncer (Bakchodi's front) rejects
      // with "unsupported startup parameter". We SET it via the on-connect
      // handler below instead — runtime SET works across all poolers.
      query_timeout: 20000, // 20s max including queue wait — client-side only
      allowExitOnIdle: isNeon, // Release all connections when idle on serverless
    });

    pool.on('error', (err) => {
      _poolMetrics.errors++;
      logger.error('PostgreSQL pool error', err, { component: 'postgres' });
    });

    pool.on('connect', (client: PoolClient) => {
      // Statement timeout: kill hung queries.
      // idle_session_timeout (PG14+): SERVER-side reap for connections that
      // sit idle. Client-side idleTimeoutMillis fails on Vercel because the
      // Lambda hibernates and setTimeout doesn't fire — 2026-08-04 obs
      // showed 6 idle conns pinned for 500+s and Aiven's 20-slot budget
      // saturated. Server-side timeout works even when the client is frozen.
      // idle_in_transaction_session_timeout guards against stuck transactions
      // that hold row locks + a connection slot indefinitely.
      // Application_name makes leaks visible in pg_stat_activity.
      const appName = (process.env.VERCEL_ENV
        ? `zkv-${process.env.VERCEL_ENV}`
        : 'zkv-local').slice(0, 63);
      client.query(`
        SET statement_timeout = 15000;
        SET idle_in_transaction_session_timeout = 10000;
        SET idle_session_timeout = 30000;
        SET application_name = '${appName.replace(/[^a-zA-Z0-9_-]/g, '')}';
      `).catch(() => {});
    });
  }

  return pool;
}

const SLOW_QUERY_MS = 2000;

// Aiven's per-plan connection_limit (20 on default) is shared across every
// Vercel instance. During post-deploy fan-out OR concurrent cron ticks +
// reconciler runs, new connections can be rejected with this exact error:
//   "remaining connection slots are reserved for roles with the SUPERUSER attribute"
// The connections themselves are transient — they free within seconds as
// other crons finish. Retry with exponential backoff instead of bubbling
// the error to the caller. 3 retries × 1s/2s/4s = up to 7s total — well
// under the 20s query_timeout. Anything more persistent means a real
// capacity issue; surface that to the caller.
const POOL_EXHAUSTED_PATTERNS = [
  /remaining connection slots are reserved/i,
  /sorry, too many clients already/i,
  /connection limit exceeded/i,
];
function isPoolExhausted(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return POOL_EXHAUSTED_PATTERNS.some((re) => re.test(msg));
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const p = getPool();
  _poolMetrics.queries++;
  const start = Date.now();
  const MAX_RETRIES = 3;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        await new Promise((r) => setTimeout(r, backoffMs));
        logger.warn(`[DB] Retry attempt ${attempt}/${MAX_RETRIES} after pool-exhaustion`, {
          component: 'postgres',
          backoffMs,
          query: text.slice(0, 80),
        });
      }
      const result = await p.query(text, params);
      const duration = Date.now() - start;
      if (attempt > 0) {
        logger.info(`[DB] Query recovered after ${attempt} retry(ies)`, {
          component: 'postgres',
          totalDurationMs: duration,
        });
      }
      if (duration > SLOW_QUERY_MS) {
        _poolMetrics.slowQueries++;
        logger.warn(`[DB] Slow query (${duration}ms): ${text.slice(0, 80)}`, {
          component: 'postgres',
          duration,
        });
      }
      return result.rows;
    } catch (err) {
      lastErr = err;
      if (!isPoolExhausted(err) || attempt === MAX_RETRIES) {
        _poolMetrics.errors++;
        throw err;
      }
      // else: loop and retry
    }
  }
  _poolMetrics.errors++;
  throw lastErr;
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

/**
 * Execute multiple queries in a single transaction for atomicity + performance.
 * Reduces round-trips to the database.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ── Centralized DB readiness ──

let _dbReady = false;
let _dbInitPromise: Promise<void> | null = null;

/**
 * Quick check: is the DB reachable? (3s timeout)
 * Returns false if no DATABASE_URL is set or connection fails.
 */
export async function isDbAvailable(): Promise<boolean> {
  if (!process.env.DATABASE_URL && !process.env.VERCEL) return false;
  try {
    await Promise.race([
      query('SELECT 1'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DB ping timeout')), 3000)
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure ALL application tables exist (idempotent, runs once).
 * Safely no-ops if the DB is unreachable.
 */
export async function ensureAllTables(): Promise<boolean> {
  if (_dbReady) return true;

  // Deduplicate concurrent callers
  if (_dbInitPromise) {
    await _dbInitPromise;
    return _dbReady;
  }

  _dbInitPromise = (async () => {
    const reachable = await isDbAvailable();
    if (!reachable) {
      logger.warn('[DB] Database unreachable — skipping table init');
      return;
    }

    try {
      // Lazy-import to avoid circular deps at module load
      const { initCommunityPoolTables } = await import('./community-pool');
      const { ensureHedgesTable } = await import('./hedges');

      await Promise.all([initCommunityPoolTables(), ensureHedgesTable()]);
      _dbReady = true;
      logger.info('[DB] All tables initialized');
    } catch (e) {
      logger.error('[DB] Table init failed (non-fatal)', { error: e });
    }
  })();

  await _dbInitPromise;
  _dbInitPromise = null;
  return _dbReady;
}
