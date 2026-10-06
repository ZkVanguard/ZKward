/**
 * A wallet signature on the auto-rebalance route proves control of one
 * wallet. These are the ways a signed-in stranger could reach past their own
 * portfolio.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { walletScopeDenial, type Auth } from '@/app/api/agents/auto-rebalance/wallet-scope';

const ME = '0xabc0000000000000000000000000000000000001';
const OTHER = '0xdef0000000000000000000000000000000000002';
const wallet: Auth = { method: 'wallet', identity: ME };
const owner = (value: unknown) => jest.fn(async (_id: number) => value);

describe('walletScopeDenial', () => {
  it('does not limit a service credential', async () => {
    const stored = owner(OTHER);
    for (const method of ['internal', 'system'] as const) {
      expect(await walletScopeDenial({ method, identity: 'service' }, 'stop', -2, undefined, stored)).toBeNull();
    }
    expect(stored).not.toHaveBeenCalled();
  });

  it('a wallet cannot start or stop the service', async () => {
    expect(await walletScopeDenial(wallet, 'start', 1, ME, owner(null))).toMatch(/service credential/);
    expect(await walletScopeDenial(wallet, 'stop', 1, ME, owner(null))).toMatch(/service credential/);
  });

  it('a wallet cannot touch the pools’ reserved ids or a malformed id', async () => {
    for (const id of [-1, -2, -3, '-2', 0, '0', '0x10', 'abc', '', null, undefined, [], {}, NaN]) {
      expect(await walletScopeDenial(wallet, 'enable', id, ME, owner(null))).toMatch(/cannot be changed/);
    }
  });

  it('the wallet in the body must be a string equal to the signer', async () => {
    for (const bad of [OTHER, undefined, null, [ME], { toLowerCase: () => ME }, 42]) {
      expect(await walletScopeDenial(wallet, 'enable', 7, bad, owner(null))).toMatch(/signing wallet/);
    }
    expect(await walletScopeDenial(wallet, 'enable', 7, ME.toUpperCase().replace('0X', '0x'), owner(null))).toBeNull();
  });

  it('a wallet cannot change a portfolio stored under another owner, in any letter case', async () => {
    expect(await walletScopeDenial(wallet, 'disable', 7, ME, owner(OTHER))).toMatch(/another wallet/);
    expect(await walletScopeDenial(wallet, 'patch', 7, ME, owner(OTHER.toUpperCase()))).toMatch(/another wallet/);
  });

  it('a stored owner that is not a string denies instead of throwing', async () => {
    expect(await walletScopeDenial(wallet, 'disable', 7, ME, owner([ME]))).toMatch(/another wallet/);
  });

  it('the owner may change their own portfolio', async () => {
    expect(await walletScopeDenial(wallet, 'disable', 7, ME, owner(ME))).toBeNull();
    expect(await walletScopeDenial(wallet, 'patch', '7', ME, owner(ME.toUpperCase().replace('0X', '0x')))).toBeNull();
  });
});
