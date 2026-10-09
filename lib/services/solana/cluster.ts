/**
 * Which Solana cluster the pool runs on, and the facts that follow from it.
 *
 * One reading of `SOLANA_CLUSTER` for the whole vertical. Everything that
 * touches money asks this module, because the ledger, the indexer's mark and
 * the faucet all have to agree on the cluster: devnet shares must never be
 * payable in mainnet tokens.
 */

export type SolanaCluster = 'mainnet-beta' | 'devnet' | 'testnet';

/** Each cluster's genesis hash: the one value an RPC cannot be on the wrong chain and still return. */
const GENESIS_HASH: Record<SolanaCluster, string> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
};

const PUBLIC_RPC: Record<SolanaCluster, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
};

/**
 * The configured cluster. Unset means devnet. An unknown value throws: a
 * typo must stop the pool, not quietly select a cluster.
 */
export function solanaCluster(): SolanaCluster {
  const raw = (process.env.SOLANA_CLUSTER || 'devnet').trim().toLowerCase();
  if (raw === 'mainnet' || raw === 'mainnet-beta') return 'mainnet-beta';
  if (raw === 'devnet' || raw === 'testnet') return raw;
  throw new Error(`SOLANA_CLUSTER "${raw}" is not a known cluster`);
}

export const isMainnet = (): boolean => solanaCluster() === 'mainnet-beta';

export const expectedGenesisHash = (): string => GENESIS_HASH[solanaCluster()];

/** The cluster's own public endpoint: the browser's fallback, and the server's on test clusters only. */
export const publicClusterRpc = (): string => PUBLIC_RPC[solanaCluster()];

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** The inverse of `base58Encode`. Throws on a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) {
    const digit = B58.indexOf(ch);
    if (digit < 0) throw new Error('not base58');
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of text) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

/** Base58, as Solana writes signatures and addresses. */
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}
