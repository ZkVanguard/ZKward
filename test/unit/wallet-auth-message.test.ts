/**
 * A wallet signature authenticates only a recent ZKward message that names
 * the signing wallet, and a wallet-signed caller sees its own hedges only.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { walletMessageProblem } from '@/lib/security/auth-middleware';

const W = '0xAbC0000000000000000000000000000000000001';
const NOW = 1_800_000_000;
// The two messages the app's clients sign (lib/hooks/useApiAuth.ts, useCommunityPool.signForApi).
const chat = (ts = NOW, wallet = W) => `ZKward AI Chat\n\nWallet: ${wallet}\ntimestamp:${ts}`;
const pool = (ts = NOW) => `ZKward Community Pool\n\nAction: DEPOSIT\nAmount: $10\nWallet: ${W}\ntimestamp:${ts}`;

describe('walletMessageProblem', () => {
  it('accepts both client messages while fresh, in any address case', () => {
    expect(walletMessageProblem(chat(), W.toLowerCase(), NOW + 10)).toBeNull();
    expect(walletMessageProblem(pool(), W.toLowerCase(), NOW)).toBeNull();
  });

  it('refuses a message with no timestamp, an old one, another wallet, or another site', () => {
    expect(walletMessageProblem(`ZKward AI Chat\n\nWallet: ${W}`, W, NOW)).toBe('no timestamp');
    expect(walletMessageProblem(chat(NOW - 301), W, NOW)).toBe('expired');
    expect(walletMessageProblem(chat(NOW, '0x0000000000000000000000000000000000000002'), W, NOW)).toBe('message names another wallet');
    expect(walletMessageProblem(`Sign in to example\nWallet: ${W}\ntimestamp:${NOW}`, W, NOW)).toBe('not a ZKward message');
  });
});

describe('hedge reads for a wallet-signed caller', () => {
  it.each(['app/api/agents/hedging/list/route.ts', 'app/api/agents/hedging/pnl/route.ts'])('%s scopes to the signer', (f) => {
    const src = fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8');
    expect(src).toContain("const ownWallet = authResult.method === 'wallet' ? authResult.identity : null;");
    expect(src).toContain("const walletAddress = ownWallet ?? searchParams.get('walletAddress');");
  });

  it('a single hedge of another wallet reads as not found', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/agents/hedging/pnl/route.ts'), 'utf8');
    expect(src).toContain('if (!hedge || (ownWallet && hedge.wallet_address?.toLowerCase() !== ownWallet.toLowerCase())) {');
  });
});
