/**
 * Minimal Solana JSON-RPC client: plain fetch, no SDK.
 *
 * Reads only. Signing lives in ./signer. Every call goes to the configured
 * endpoints in order, and no endpoint is trusted until its genesis hash
 * matches the configured cluster: a devnet URL left in a mainnet deployment
 * would otherwise credit test deposits as real ones.
 */
import { expectedGenesisHash, isMainnet, publicClusterRpc, solanaCluster } from './cluster';

const TIMEOUT_MS = 10_000;

/**
 * The server's endpoints, in failover order (`SOLANA_RPC_URL`, comma
 * separated). Mainnet must name its own: the public mainnet endpoint
 * rate-limits, and falling back to it silently would look like an outage.
 */
export function solanaRpcUrls(): string[] {
  const urls = (process.env.SOLANA_RPC_URL || '').split(',').map((u) => u.trim()).filter(Boolean);
  if (urls.length) return urls;
  if (isMainnet()) throw new Error('SOLANA_RPC_URL is required on mainnet');
  return [publicClusterRpc()];
}

export const solanaRpcUrl = (): string => solanaRpcUrls()[0];

/**
 * The endpoint the browser may use. Never the server's: that URL carries a
 * provider key on mainnet.
 */
export function solanaPublicRpcUrl(): string {
  return (process.env.SOLANA_PUBLIC_RPC_URL || '').trim() || publicClusterRpc();
}

let rpcId = 0;

async function post<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`solana rpc ${method}: HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (json.error) throw new Error(`solana rpc ${method}: ${json.error.code} ${json.error.message}`);
  return json.result as T;
}

/** Endpoints already shown to be on the configured cluster, per cluster. */
const verified = new Map<string, Promise<void>>();

/**
 * Throws unless `url` answers with the configured cluster's genesis hash.
 * A passing check is remembered; a failing one is asked again next time.
 */
export function assertEndpointOnCluster(url: string): Promise<void> {
  const key = `${solanaCluster()}|${url}`;
  let check = verified.get(key);
  if (!check) {
    check = post<string>(url, 'getGenesisHash', []).then((hash) => {
      if (hash !== expectedGenesisHash()) {
        throw new Error(`Solana RPC is not on ${solanaCluster()} (genesis ${String(hash).slice(0, 8)}…)`);
      }
    });
    verified.set(key, check);
    check.catch(() => verified.delete(key));
  }
  return check;
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  let lastErr: unknown;
  for (const url of solanaRpcUrls()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await assertEndpointOnCluster(url);
        return await post<T>(url, method, params);
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`solana rpc ${method} failed`);
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown | null;
  blockTime: number | null;
}

/** Newest-first signatures involving `address`, optionally until a known signature. */
export function getSignaturesForAddress(
  address: string,
  opts: { until?: string; before?: string; limit?: number } = {},
): Promise<SignatureInfo[]> {
  // Finalized only: a deposit is credited once it can no longer be rolled back.
  const cfg: Record<string, unknown> = { limit: opts.limit ?? 50, commitment: 'finalized' };
  if (opts.until) cfg.until = opts.until;
  if (opts.before) cfg.before = opts.before;
  return rpcCall<SignatureInfo[]>('getSignaturesForAddress', [address, cfg]);
}

export interface SignatureStatus {
  err: unknown | null;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
}

/** Status of one signature, searching history; null when the cluster has never seen it. */
export async function getSignatureStatus(signature: string): Promise<SignatureStatus | null> {
  const r = await rpcCall<{ value: Array<SignatureStatus | null> }>('getSignatureStatuses', [
    [signature],
    { searchTransactionHistory: true },
  ]);
  return r.value[0] ?? null;
}

/** Finalized block height: past a transaction's last valid height, that transaction can never land. */
export function getFinalizedBlockHeight(): Promise<number> {
  return rpcCall<number>('getBlockHeight', [{ commitment: 'finalized' }]);
}

/** Lamports held by an account. */
export async function getLamports(address: string): Promise<number> {
  const r = await rpcCall<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
  return r.value;
}

/** jsonParsed transaction — token transfers readable without SDK decoding. */
export function getTransaction(signature: string): Promise<ParsedTransaction | null> {
  return rpcCall<ParsedTransaction | null>('getTransaction', [
    signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' },
  ]);
}

export interface ParsedTransaction {
  slot: number;
  blockTime: number | null;
  meta: { err: unknown | null } | null;
  transaction: {
    message: {
      instructions: ParsedInstruction[];
    };
  };
}

export interface ParsedInstruction {
  program?: string;
  programId?: string;
  parsed?: {
    type?: string;
    info?: Record<string, unknown>;
  };
}

/** UI amount of an SPL token account. Chain is the balance truth (no DB counter). */
export async function getTokenAccountBalance(
  tokenAccount: string,
): Promise<{ amount: string; decimals: number; uiAmount: number }> {
  const r = await rpcCall<{ value: { amount: string; decimals: number; uiAmount: number | null } }>(
    'getTokenAccountBalance',
    [tokenAccount, { commitment: 'confirmed' }],
  );
  return {
    amount: r.value.amount,
    decimals: r.value.decimals,
    uiAmount: r.value.uiAmount ?? Number(r.value.amount) / 10 ** r.value.decimals,
  };
}

/**
 * Extract SPL transfers into `vaultAta` from a parsed transaction.
 * Handles `transfer` (amount in raw units) and `transferChecked`
 * (tokenAmount.amount). Returns raw base-unit amounts as bigint.
 */
export function extractDepositsToVault(
  tx: ParsedTransaction,
  vaultAta: string,
): Array<{ source: string; authority: string; rawAmount: bigint }> {
  if (tx.meta?.err) return [];
  const out: Array<{ source: string; authority: string; rawAmount: bigint }> = [];
  for (const ix of tx.transaction.message.instructions) {
    if (ix.program !== 'spl-token' || !ix.parsed?.info) continue;
    const t = ix.parsed.type;
    if (t !== 'transfer' && t !== 'transferChecked') continue;
    const info = ix.parsed.info as Record<string, unknown>;
    if (info.destination !== vaultAta) continue;
    const raw =
      t === 'transfer'
        ? String(info.amount ?? '0')
        : String((info.tokenAmount as { amount?: string } | undefined)?.amount ?? '0');
    out.push({
      source: String(info.source ?? ''),
      authority: String(info.authority ?? info.multisigAuthority ?? ''),
      rawAmount: BigInt(raw),
    });
  }
  return out;
}
