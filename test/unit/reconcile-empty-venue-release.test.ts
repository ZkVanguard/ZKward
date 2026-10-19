/**
 * The reconciler refuses to close every row on one empty venue answer (a blip),
 * but a venue that stays empty must not keep closed positions "active" forever:
 * after the confirm window of consecutive empty answers the rows close as
 * reconciled. Any non-empty answer resets the window.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/cron/bluefin-db-reconcile/route.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('bluefin-db-reconcile empty-venue release path', () => {
  it('confirms emptiness over 45 minutes, read strictly, and resets on any non-empty answer', () => {
    expect(src).toContain('const EMPTY_CONFIRM_MS = 45 * 60_000;');
    expect(src).toContain('getCronStateStrict<number>(KEY_VENUE_EMPTY_SINCE)');
    const reset = src.indexOf('if (positions.length > 0) {');
    expect(src.slice(reset, reset + 120)).toContain('setCronState(KEY_VENUE_EMPTY_SINCE, null)');
  });

  it('still bails on an unconfirmed empty answer, and only proceeds once confirmed', () => {
    const confirmed = src.indexOf('if (positions.length === 0 && dbNotionalCount > 0 && venueConfirmedEmpty) {');
    const bail = src.indexOf('} else if (positions.length === 0 && dbNotionalCount > 0) {');
    expect(confirmed).toBeGreaterThan(0);
    expect(bail).toBeGreaterThan(confirmed);
    expect(src.slice(bail, bail + 1500)).toContain("error: `safety-bail: empty positions vs ${dbNotionalCount} notional DB hedges`");
  });

  it('rows it closes this way record no result as settled', () => {
    expect(src).toContain("await closeHedge(h.order_id, 0, 'closed', RECONCILED_CLOSE);");
  });
});
