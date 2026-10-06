/**
 * The record-deposit and record-withdraw actions take their facts from the
 * event the pool contract emitted, never from the request body. These cases
 * are the ways a caller could try to get a record written for a deposit or
 * withdrawal that is not theirs or never happened.
 */
import { describe, it, expect } from '@jest/globals';
import { checkPoolTx } from '@/app/api/sui/community-pool/handlers/pool-tx-proof';

// The live pool was upgraded: events keep the id of the package that first
// defined them, while the emitting package is the current one.
const ORIGINAL_PKG = '0x8f2534a7' + 'a'.repeat(56);
const CURRENT_PKG = '0x107292a6' + 'b'.repeat(56);
const ATTACKER_PKG = '0x' + 'e'.repeat(64);
const MEMBER = '0x880cfa49' + 'c'.repeat(56);
const STRANGER = '0x' + '1'.repeat(64);
const MODULE = 'community_pool_usdc';
const POOL = '0xe814e094' + 'd'.repeat(56);
const OTHER_POOL = '0x' + '7'.repeat(64);

const deposit = (over: Record<string, unknown> = {}, pkg = ORIGINAL_PKG, emitter = CURRENT_PKG) => ({
  type: `${pkg}::${MODULE}::UsdcDeposited`,
  packageId: emitter,
  parsedJson: { member: MEMBER, amount_usdc: '30000000', shares_received: '43876106', share_price: '683743', timestamp: '1', ...over },
});
const withdrawal = (over: Record<string, unknown> = {}) => ({
  type: `${ORIGINAL_PKG}::${MODULE}::UsdcWithdrawn`,
  packageId: CURRENT_PKG,
  parsedJson: { member: MEMBER, shares_burned: '10000000', amount_usdc: '6837430', share_price: '683743', timestamp: '1', ...over },
});
const ok = { status: { status: 'success' }, mutated: [{ reference: { objectId: '0x' + '9'.repeat(64) } }, { reference: { objectId: POOL } }] };
const expectDeposit = { kind: 'UsdcDeposited' as const, packageId: CURRENT_PKG, moduleName: MODULE, wallet: MEMBER, poolStateId: POOL };
const expectWithdraw = { ...expectDeposit, kind: 'UsdcWithdrawn' as const };

describe('checkPoolTx', () => {
  it('accepts a deposit emitted by the upgraded package and reads amount and shares from the event', () => {
    expect(checkPoolTx({ effects: ok, events: [deposit()] }, expectDeposit)).toEqual({ ok: true, amountUsdc: 30, shares: 43.876106 });
  });

  it('accepts an event whose type is defined in the configured package', () => {
    const r = checkPoolTx({ effects: ok, events: [deposit({}, CURRENT_PKG, CURRENT_PKG)] }, expectDeposit);
    expect(r.ok).toBe(true);
  });

  it('accepts a withdrawal and reads shares burned and USDC paid', () => {
    expect(checkPoolTx({ effects: ok, events: [withdrawal()] }, expectWithdraw)).toEqual({ ok: true, amountUsdc: 6.83743, shares: 10 });
  });

  it('matches the wallet regardless of letter case', () => {
    const r = checkPoolTx({ effects: ok, events: [deposit()] }, { ...expectDeposit, wallet: MEMBER.toUpperCase().replace('0X', '0x') });
    expect(r.ok).toBe(true);
  });

  it('refuses a transaction that failed on chain', () => {
    expect(checkPoolTx({ effects: { status: { status: 'failure' } }, events: [deposit()] }, expectDeposit)).toEqual({ ok: false, reason: 'tx-failed' });
    expect(checkPoolTx({ events: [deposit()] }, expectDeposit)).toEqual({ ok: false, reason: 'tx-failed' });
  });

  it('refuses a real pool event from a transaction that did not change this pool', () => {
    const elsewhere = { status: { status: 'success' }, mutated: [{ reference: { objectId: OTHER_POOL } }] };
    expect(checkPoolTx({ effects: elsewhere, events: [deposit()] }, expectDeposit)).toEqual({ ok: false, reason: 'other-pool' });
    expect(checkPoolTx({ effects: { status: { status: 'success' } }, events: [deposit()] }, expectDeposit)).toEqual({ ok: false, reason: 'other-pool' });
  });

  it('refuses a real deposit claimed by a different wallet', () => {
    expect(checkPoolTx({ effects: ok, events: [deposit()] }, { ...expectDeposit, wallet: STRANGER })).toEqual({ ok: false, reason: 'not-your-transaction' });
  });

  it('refuses a look-alike event from another package with the same module and event name', () => {
    const fake = deposit({ member: STRANGER, amount_usdc: '9000000000000' }, ATTACKER_PKG, ATTACKER_PKG);
    expect(checkPoolTx({ effects: ok, events: [fake] }, { ...expectDeposit, wallet: STRANGER })).toEqual({ ok: false, reason: 'no-pool-event' });
  });

  it('refuses a transaction with no pool event at all', () => {
    const other = { type: `${ORIGINAL_PKG}::${MODULE}::ExternalNavAttested`, packageId: CURRENT_PKG, parsedJson: {} };
    expect(checkPoolTx({ effects: ok, events: [other] }, expectDeposit)).toEqual({ ok: false, reason: 'no-pool-event' });
    expect(checkPoolTx({ effects: ok, events: [] }, expectDeposit)).toEqual({ ok: false, reason: 'no-pool-event' });
    expect(checkPoolTx({ effects: ok, events: null }, expectDeposit)).toEqual({ ok: false, reason: 'no-pool-event' });
  });

  it('refuses a deposit offered as a withdrawal and the reverse', () => {
    expect(checkPoolTx({ effects: ok, events: [deposit()] }, expectWithdraw)).toEqual({ ok: false, reason: 'no-pool-event' });
    expect(checkPoolTx({ effects: ok, events: [withdrawal()] }, expectDeposit)).toEqual({ ok: false, reason: 'no-pool-event' });
  });

  it('refuses an event with a missing, zero or non-numeric amount', () => {
    for (const bad of [{ amount_usdc: '0' }, { amount_usdc: undefined }, { amount_usdc: 'lots' }, { shares_received: '-5' }]) {
      expect(checkPoolTx({ effects: ok, events: [deposit(bad)] }, expectDeposit)).toEqual({ ok: false, reason: 'bad-event' });
    }
  });

  it('counts only this wallet when one transaction carries deposits by several members', () => {
    const events = [deposit(), deposit({ member: STRANGER, amount_usdc: '500000000', shares_received: '700000000' })];
    expect(checkPoolTx({ effects: ok, events }, expectDeposit)).toEqual({ ok: true, amountUsdc: 30, shares: 43.876106 });
  });
});
