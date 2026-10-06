/**
 * What a wallet signature is allowed to change on the auto-rebalance route.
 *
 * A signature proves control of one wallet, so it covers that wallet's own
 * portfolio and nothing else: not the service switch, not the pools' reserved
 * (negative) ids, not a portfolio whose stored owner is someone else. A
 * service credential is not limited.
 */
export type Auth = { method: 'internal' | 'wallet' | 'system'; identity: string };

export async function walletScopeDenial(
  auth: Auth,
  action: string | null,
  portfolioId: unknown,
  walletAddress: unknown,
  getStoredOwner: (portfolioId: number) => Promise<unknown>,
): Promise<string | null> {
  if (auth.method !== 'wallet') return null;

  if (action === 'start' || action === 'stop') return 'Service control requires a service credential';
  const id = parseInt(String(portfolioId), 10);
  if (!Number.isInteger(id) || id <= 0) return 'This portfolio cannot be changed with a wallet signature';
  // A non-string here would be stored as the owner and break every later check.
  if (typeof walletAddress !== 'string' || walletAddress.toLowerCase() !== auth.identity) {
    return 'walletAddress must be the signing wallet';
  }
  const owner = await getStoredOwner(id);
  if (owner !== null && owner !== undefined && (typeof owner !== 'string' || owner.toLowerCase() !== auth.identity)) {
    return 'This portfolio belongs to another wallet';
  }
  return null;
}
