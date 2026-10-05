/**
 * Errors reported by visitors' browsers: uncaught exceptions, rejected
 * promises, crashed views and API calls that answered 5xx.
 *
 * Why our own table: until this existed the only way to learn of a browser
 * error was a visitor pasting their console. The stack stays on our own
 * database; no third-party service sees it.
 */
import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';

export const CLIENT_ERROR_KINDS = ['error', 'rejection', 'boundary', 'api'] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

export interface ClientErrorRow {
  kind: ClientErrorKind;
  message: string;
  stack?: string | null;
  /** Page path and query the error happened on. */
  page?: string | null;
  /** For kind 'api': the request path and its status. */
  apiPath?: string | null;
  apiStatus?: number | null;
  /** Platform request id of the failed call; finds its server log line. */
  requestId?: string | null;
  build?: string | null;
  userAgent?: string | null;
}

const RETENTION_DAYS = 30;
let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS client_errors (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT,
      page TEXT,
      api_path TEXT,
      api_status INT,
      request_id TEXT,
      build TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_client_errors_created ON client_errors(created_at);
  `);
  tableReady = true;
}

const clip = (v: string | null | undefined, max: number): string | null => (v ? String(v).slice(0, max) : null);

export async function recordClientError(row: ClientErrorRow): Promise<void> {
  await ensureTable();
  await query(
    `INSERT INTO client_errors (kind, message, stack, page, api_path, api_status, request_id, build, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.kind,
      clip(row.message, 500) ?? '(no message)',
      clip(row.stack, 4000),
      clip(row.page, 300),
      clip(row.apiPath, 300),
      Number.isFinite(row.apiStatus) ? row.apiStatus : null,
      clip(row.requestId, 120),
      clip(row.build, 40),
      clip(row.userAgent, 300),
    ],
  );
  // The prune rides the writes: about one in fifty, so a busy day costs a handful of deletes.
  if (Math.random() < 0.02) {
    await query(`DELETE FROM client_errors WHERE created_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`).catch((e) => {
      logger.warn('[client-errors] prune failed', { error: e instanceof Error ? e.message : String(e) });
    });
  }
}
