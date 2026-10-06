/**
 * Golden tests for the community-pool pure utilities
 * (components/dashboard/community-pool/utils.ts): formatters, chain mapping,
 * and the deposit/withdraw input validators (the user-money boundary).
 */
import { describe, it, expect } from '@jest/globals';
import {
  formatUSD,
  formatPercent,
  formatShares,
  truncateAddress,
  getChainKeyFromId,
  getNetworkFromChainId,
  validateDepositAmount,
  validateWithdrawShares,
  validateSuiDeposit,
  getAllocationPercent,
  getActiveAllocations,
} from '@/components/dashboard/community-pool/utils';

describe('formatters', () => {
  it('formatUSD scales K/M', () => {
    expect(formatUSD(500)).toBe('$500.00');
    expect(formatUSD(1500)).toBe('$1.50K');
    expect(formatUSD(2_500_000)).toBe('$2.50M');
    expect(formatUSD(48.69)).toBe('$48.69');
  });
  it('formatPercent → 1 decimal', () => {
    expect(formatPercent(61.149)).toBe('61.1%');
    expect(formatPercent(0)).toBe('0.0%');
  });
  it('formatShares rounds to N decimals', () => {
    expect(formatShares(30.2107)).toBe('30.2107');
    expect(formatShares(1.123456, 2)).toBe('1.12');
    expect(formatShares(0)).toBe('0');
  });
  it('truncateAddress middle-ellipsizes long addresses only', () => {
    expect(truncateAddress('0x1234567890abcdef')).toBe('0x1234...cdef');
    expect(truncateAddress('0xabc')).toBe('0xabc'); // short → unchanged
    expect(truncateAddress('')).toBe('');
  });
});

describe('chain mapping', () => {
  it('getChainKeyFromId', () => {
    expect(getChainKeyFromId(296)).toBe('hedera');
    expect(getChainKeyFromId(295)).toBe('hedera');
    expect(getChainKeyFromId(1)).toBeNull();
    expect(getChainKeyFromId(999)).toBeNull();
  });
  it('getNetworkFromChainId', () => {
    expect(getNetworkFromChainId(295)).toBe('mainnet');
    expect(getNetworkFromChainId(296)).toBe('testnet');
    expect(getNetworkFromChainId(0)).toBe('testnet');
  });
});

describe('deposit/withdraw validators (money boundary)', () => {
  it('validateDepositAmount enforces presence, positivity, minimum', () => {
    expect(validateDepositAmount('').valid).toBe(false);
    expect(validateDepositAmount('0').valid).toBe(false);
    expect(validateDepositAmount('abc').valid).toBe(false);
    expect(validateDepositAmount('5', 10).valid).toBe(false); // below min
    expect(validateDepositAmount('20', 10)).toEqual({ valid: true });
  });
  it('validateWithdrawShares enforces presence, positivity, max', () => {
    expect(validateWithdrawShares('', 100).valid).toBe(false);
    expect(validateWithdrawShares('-1', 100).valid).toBe(false);
    expect(validateWithdrawShares('150', 100).valid).toBe(false); // above max
    expect(validateWithdrawShares('50', 100)).toEqual({ valid: true });
  });
  it('validateSuiDeposit enforces SUI minimum', () => {
    expect(validateSuiDeposit('0.05', 0.1).valid).toBe(false);
    expect(validateSuiDeposit('1', 0.1)).toEqual({ valid: true });
    expect(validateSuiDeposit('').valid).toBe(false);
  });
});

describe('allocation utils', () => {
  it('getAllocationPercent normalizes number | {percentage}', () => {
    expect(getAllocationPercent(30)).toBe(30);
    expect(getAllocationPercent({ percentage: 25 })).toBe(25);
    expect(getAllocationPercent({})).toBe(0);
  });
  it('getActiveAllocations keeps only positive entries', () => {
    const out = getActiveAllocations({ BTC: 30, ETH: 0, SUI: { percentage: 20 }, CRO: { percentage: 0 } });
    expect(out).toEqual([['BTC', 30], ['SUI', 20]]);
  });
});
