import { describe, it, expect } from '@jest/globals';
import { suggestChain, type SuggestInput } from '@/lib/wallet/suggest-chain';

const base: SuggestInput = { linkChain: null, lastChain: null, suiWallets: [], solanaWallet: false };

describe('suggestChain', () => {
  it('a link that names a network wins', () => {
    expect(suggestChain({ ...base, linkChain: 'solana', lastChain: 'sui', suiWallets: ['Slush'] })).toEqual({ chain: 'solana', reason: 'link' });
  });

  it('then the network this device used last', () => {
    expect(suggestChain({ ...base, lastChain: 'hedera', suiWallets: ['Slush'] })).toEqual({ chain: 'hedera', reason: 'last' });
  });

  it('a SUI wallet suggests SUI', () => {
    expect(suggestChain({ ...base, suiWallets: ['Slush'], solanaWallet: true })).toEqual({ chain: 'sui', reason: 'wallet' });
  });

  it('Phantom alone suggests Solana even though it also registers for SUI', () => {
    expect(suggestChain({ ...base, suiWallets: ['Phantom'], solanaWallet: true })).toEqual({ chain: 'solana', reason: 'wallet' });
  });

  it('with nothing installed, Hedera works through email sign-in', () => {
    expect(suggestChain(base)).toEqual({ chain: 'hedera', reason: 'no-install' });
  });
});
