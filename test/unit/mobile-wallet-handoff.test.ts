/**
 * On a phone, SUI and Solana wallets live in their own apps. The chooser
 * hands the page to the wallet app's browser with the network selected and
 * an instruction to connect on arrival.
 */
import { describe, it, expect } from '@jest/globals';
import { SOLANA_MOBILE_WALLETS, SUI_MOBILE_WALLETS, handoffTarget, walletHandoffLink } from '@/lib/utils/mobile-wallet';

const PAGE = 'https://www.zkward.com/en/dashboard?tab=pool';

describe('mobile wallet handoff', () => {
  it('the target page selects the network and asks to connect, keeping the rest of the URL', () => {
    const u = new URL(handoffTarget(PAGE, 'solana'));
    expect(u.pathname).toBe('/en/dashboard');
    expect(u.searchParams.get('tab')).toBe('pool');
    expect(u.searchParams.get('chain')).toBe('solana');
    expect(u.searchParams.get('connect')).toBe('solana');
  });

  it('Phantom and Solflare get their browse links with the page and its origin as ref', () => {
    const [phantom, solflare] = SOLANA_MOBILE_WALLETS;
    const target = encodeURIComponent(handoffTarget(PAGE, 'solana'));
    const ref = encodeURIComponent('https://www.zkward.com');
    expect(walletHandoffLink(phantom, 'solana', PAGE)).toBe(`https://phantom.app/ul/browse/${target}?ref=${ref}`);
    expect(walletHandoffLink(solflare, 'solana', PAGE)).toBe(`https://solflare.com/ul/v1/browse/${target}?ref=${ref}`);
  });

  it('Slush opens the page set up for SUI', () => {
    const link = walletHandoffLink(SUI_MOBILE_WALLETS[0], 'sui', PAGE);
    expect(link.startsWith('https://my.slush.app/browse/')).toBe(true);
    const inner = new URL(decodeURIComponent(link.slice('https://my.slush.app/browse/'.length)));
    expect(inner.searchParams.get('connect')).toBe('sui');
  });
});
