/**
 * Sends this browser's errors to /api/client-errors: uncaught exceptions,
 * rejected promises, crashed views (from the error screens) and our own API
 * calls that answered 5xx, with the platform's request id so the server log
 * line can be found.
 *
 * It must never make things worse: every path swallows its own failure, a
 * page load reports at most MAX_REPORTS, and the same message is sent once.
 */
export type ClientErrorKind = 'error' | 'rejection' | 'boundary' | 'api';

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  apiPath?: string;
  apiStatus?: number;
  requestId?: string;
}

const ENDPOINT = '/api/client-errors';
const MAX_REPORTS = 10;
const seen = new Set<string>();
let sent = 0;

/** Errors thrown inside a browser extension's own script are not ours and not fixable here. */
export function isForeignSource(source: string | undefined | null): boolean {
  return !!source && /^(chrome|moz|safari-web)-extension:\/\//.test(source);
}

/** Whether this report should be sent, and count it. Pure apart from the module's own counters. */
export function admit(report: ClientErrorReport): boolean {
  if (sent >= MAX_REPORTS) return false;
  const key = `${report.kind}|${report.message}|${report.apiPath ?? ''}`;
  if (seen.has(key)) return false;
  seen.add(key);
  sent++;
  return true;
}

export function _resetReporterForTest(): void {
  seen.clear();
  sent = 0;
}

export function reportClientError(report: ClientErrorReport): void {
  try {
    if (typeof window === 'undefined' || !admit(report)) return;
    const body = JSON.stringify({ ...report, stack: report.stack?.slice(0, 4000), page: window.location.pathname + window.location.search });
    // keepalive: the report survives the page being closed or navigated away from.
    void fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => undefined);
  } catch {
    /* reporting is best effort */
  }
}

let installed = false;

export function installClientErrorReporter(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (e) => {
    if (isForeignSource(e.filename) || isForeignSource(e.error?.stack)) return;
    // Resource load failures (an image, a script tag) arrive here without a message.
    if (!e.message) return;
    reportClientError({ kind: 'error', message: e.message, stack: e.error?.stack });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { message?: string; stack?: string } | string | undefined;
    const stack = typeof reason === 'object' ? reason?.stack : undefined;
    if (isForeignSource(stack)) return;
    const message = typeof reason === 'string' ? reason : reason?.message || 'unhandled rejection';
    reportClientError({ kind: 'rejection', message, stack });
  });

  // Our own API answering 5xx. The wrapper returns exactly what fetch returned.
  const original = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const response = await original(...args);
    try {
      if (response.status >= 500) {
        const url = new URL(response.url || String(args[0]), window.location.origin);
        if (url.origin === window.location.origin && url.pathname.startsWith('/api/') && url.pathname !== ENDPOINT) {
          reportClientError({
            kind: 'api',
            message: `${url.pathname} answered ${response.status}`,
            apiPath: url.pathname + url.search,
            apiStatus: response.status,
            requestId: response.headers.get('x-vercel-id') ?? undefined,
          });
        }
      }
    } catch {
      /* never let reporting touch the response */
    }
    return response;
  };
}
