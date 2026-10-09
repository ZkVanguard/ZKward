/**
 * A cron heartbeat means "an authenticated run started". Written before the
 * auth check, any unauthenticated request keeps the job looking alive: the
 * heartbeat monitor would stay quiet through a dead scheduler, and a retired
 * route showed a fresh heartbeat it never earned.
 */
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CRON_DIR = join(process.cwd(), 'app', 'api', 'cron');

describe('cron heartbeats are written after authentication', () => {
  const routes = readdirSync(CRON_DIR).filter((d) => existsSync(join(CRON_DIR, d, 'route.ts')));

  it('finds the cron routes', () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  for (const route of routes) {
    it(`${route}`, () => {
      const lines = readFileSync(join(CRON_DIR, route, 'route.ts'), 'utf8').split(/\r?\n/);
      const auth = lines.findIndex((l) => l.includes('verifyCronRequest(request'));
      const heartbeat = lines.findIndex((l) => l.includes('setCronState') && (l.includes('cron:lastRun:') || l.includes('KEY_LAST_RUN')));
      if (auth === -1 || heartbeat === -1) return; // helper-delegated routes are covered where the helper lives
      // The rejection, not the call: a write between the two runs for every
      // unauthenticated request.
      const rejected = lines.findIndex((l, i) => i >= auth && /!==\s*true|instanceof NextResponse|status:\s*401/.test(l));
      expect(rejected).toBeGreaterThan(-1);
      expect(heartbeat).toBeGreaterThan(rejected);
    });
  }
});
