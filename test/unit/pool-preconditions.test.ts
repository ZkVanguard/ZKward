/**
 * Two conditions went unseen for days in October 2026: the pool contract
 * refusing users because its attestation was stale, and a position on the
 * venue that nothing would close. These pin how each is judged.
 */
import { describe, it, expect } from '@jest/globals';
import { attestationStatus, attestationsLeft, gasRunwayLevel } from '@/lib/services/sui/attestation-status';
import { findUnmanagedPositions, describeUnmanaged } from '@/lib/services/sui/unmanaged-positions';

const NOW = 1_791_820_000_000;
const min = (m: number) => NOW - m * 60_000;

describe('attestation status', () => {
  it('fresh is ok', () => {
    expect(attestationStatus({ required: true, tsMs: min(10), nowMs: NOW })).toMatchObject({ status: 'ok', blocked: false });
  });

  it('past an hour warns while users can still transact', () => {
    expect(attestationStatus({ required: true, tsMs: min(75), nowMs: NOW })).toMatchObject({ status: 'warn', blocked: false });
  });

  it('past two hours the contract is refusing users: the state of 2026-10-06 to 10-12', () => {
    const s = attestationStatus({ required: true, tsMs: min(146 * 60), nowMs: NOW });
    expect(s).toMatchObject({ status: 'down', blocked: true });
    expect(Math.round(s.ageMin!)).toBe(146 * 60);
  });

  it('never attested is blocked, not healthy', () => {
    expect(attestationStatus({ required: true, tsMs: undefined, nowMs: NOW })).toMatchObject({ status: 'down', blocked: true });
    expect(attestationStatus({ required: true, tsMs: 0, nowMs: NOW }).blocked).toBe(true);
  });

  it('with strict mode off a stale attestation blocks nobody', () => {
    expect(attestationStatus({ required: false, tsMs: min(9999), nowMs: NOW })).toMatchObject({ status: 'ok', blocked: false });
  });
});

describe('gas runway', () => {
  it('counts whole attestations the balance covers', () => {
    expect(attestationsLeft('2963961')).toBe(11);
    expect(attestationsLeft(0n)).toBe(0);
    expect(attestationsLeft(100_000_000)).toBe(400);
  });

  it('warns under 200 and is urgent under 20', () => {
    expect(gasRunwayLevel(400)).toBe('ok');
    expect(gasRunwayLevel(199)).toBe('warn');
    expect(gasRunwayLevel(11)).toBe('urgent');
  });
});

describe('positions nothing will close', () => {
  const sol = { symbol: 'SOL-PERP', side: 'LONG' as const, size: 0.2 };
  const eth = { symbol: 'ETH-PERP', side: 'SHORT' as const, size: 0.01 };
  const solRow = { market: 'SOL-PERP', side: 'LONG', order_id: 'polyedge_SOL_5971132' };
  const ethRow = { market: 'ETH-PERP', side: 'SHORT', order_id: 'reconstructed_ETH-PERP_SHORT' };

  it('the position of 2026-10-07: the row is the live trader\'s and the trader tracks nothing', () => {
    const found = findUnmanagedPositions([sol, eth], [solRow, ethRow], null);
    expect(found).toEqual([{ ...sol, reason: 'trader-lost-track', seen: 1 }]);
    expect(describeUnmanaged(found[0])).toBe('SOL-PERP LONG 0.2 (the live trader no longer tracks it)');
  });

  it('is managed while the trader still tracks that symbol', () => {
    expect(findUnmanagedPositions([sol], [solRow], 'SOL-PERP')).toEqual([]);
  });

  it('a trade the trader tracks on another symbol does not cover it', () => {
    expect(findUnmanagedPositions([sol], [solRow], 'BTC-PERP')[0].reason).toBe('trader-lost-track');
  });

  it('a venue position with no active row at all', () => {
    expect(findUnmanagedPositions([sol], [], 'SOL-PERP')).toEqual([{ ...sol, reason: 'no-row', seen: 1 }]);
    // the other side of the same market is a different position
    expect(findUnmanagedPositions([sol], [{ ...solRow, side: 'SHORT' }], 'SOL-PERP')[0].reason).toBe('no-row');
  });

  it('a row the pool or the reconciler owns counts as managed', () => {
    expect(findUnmanagedPositions([eth], [ethRow], null)).toEqual([]);
  });

  it('counts consecutive sightings, and starts again when it was not seen last run', () => {
    const first = findUnmanagedPositions([sol], [solRow], null);
    const second = findUnmanagedPositions([sol], [solRow], null, first);
    expect(second[0].seen).toBe(2);
    expect(findUnmanagedPositions([sol], [solRow], null, [])[0].seen).toBe(1);
  });

  it('ignores an empty position', () => {
    expect(findUnmanagedPositions([{ ...sol, size: 0 }], [], null)).toEqual([]);
  });
});
