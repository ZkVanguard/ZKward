/**
 * Minimal Solana JSON-RPC client — plain fetch, zero SDK.
 *
 * The testnet pool only READS the chain (deposit indexing + vault balance);
 * nothing here signs or sends. Server-side signing is a later, deliberate
 * decision (plan §T-later). Keeping this SDK-free keeps the Vercel build
 * untouched by the @solana/web3.js dependency tree (§1e dependency policy).
 */

const DEFAULT_RPC = 'https://api.devnet.solana.com';
const TIMEOUT_MS = 10_000;

export function solanaRpcUrl(): string {
  return (process.env.SOLANA_RPC_URL || DEFAULT_RPC).trim();
}

let rpcId = 0;

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(solanaRpcUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`solana rpc ${method}: HTTP ${res.status}`);
      const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (json.error) throw new Error(`solana rpc ${method}: ${json.error.code} ${json.error.message}`);
      return json.result as T;
    } catch (e) {
      lastErr = e;
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
  opts: { until?: string; limit?: number } = {},
): Promise<SignatureInfo[]> {
  const cfg: Record<string, unknown> = { limit: opts.limit ?? 50 };
  if (opts.until) cfg.until = opts.until;
  return rpcCall<SignatureInfo[]>('getSignaturesForAddress', [address, cfg]);
}

/** jsonParsed transaction — token transfers readable without SDK decoding. */
export function getTransaction(signature: string): Promise<ParsedTransaction | null> {
  return rpcCall<ParsedTransaction | null>('getTransaction', [
    signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
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
