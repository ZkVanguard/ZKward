/**
 * The web wallet and the installed Slush share the name "Slush", so the hub
 * tells them apart by identity. If this breaks, every visitor looks like they
 * installed a SUI wallet and phones lose the "open in the wallet app" link.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const registerSlushWallet = jest.fn();
jest.mock('@mysten/slush-wallet', () => ({ registerSlushWallet }));

import { isSlushWeb, registerSlushWeb } from '@/lib/wallet/slush-web';

describe('slush web wallet identity', () => {
  beforeEach(() => registerSlushWallet.mockReset());

  it('only the registered instance is the web wallet, not another wallet with the same name', () => {
    const web = { name: 'Slush' };
    const installed = { name: 'Slush' };
    const unregister = jest.fn();
    registerSlushWallet.mockReturnValue({ wallet: web, unregister });

    const undo = registerSlushWeb('ZKward');
    expect(registerSlushWallet).toHaveBeenCalledWith('ZKward');
    expect(isSlushWeb(web)).toBe(true);
    expect(isSlushWeb(installed)).toBe(false);

    undo();
    expect(unregister).toHaveBeenCalled();
    expect(isSlushWeb(web)).toBe(false);
  });

  it('nothing is the web wallet when the SDK steps aside for the installed Slush', () => {
    registerSlushWallet.mockReturnValue(undefined);
    const undo = registerSlushWeb('ZKward');
    expect(isSlushWeb({ name: 'Slush' })).toBe(false);
    undo();
  });
});
