/**
 * Real-token USD price via mainnet Jupiter quote probe.
 *
 * The pool token has no DexScreener/Coingecko listing — its only price truth
 * is what Jupiter will actually route (one Raydium AMM). We probe with a
 * small fixed size (0.1 SOL) so the quote reflects the top of the book, then
 * convert through the platform's validated SOL/USD mark.
 *
 * On devnet the mirror mint has no market at all; NAV display prices the
 * mirror at the REAL token's mainnet price, labeled TESTNET in the UI.
 *
 * Never throws into NAV paths: returns null on any failure, callers render
 * "price unavailable" rather than a fake number.
 */

const JUP_QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const PROBE_LAMPORTS = 100_000_000; // 0.1 SOL — small enough to read top-of-book
const TTL_MS = 60_000;
const MAX_JUMP_FRAC = 0.2; // reject >20% moves per refresh — single-AMM manipulation guard

export function poolTokenMint(): string {
  return (process.env.SOLANA_POOL_TOKEN_MINT_MAINNET || 'D86WEcSeM4YkQKqP6LLLt8bRypbJnaQcPUxHAVsopump').trim();
}

interface CachedPrice {
  usd: number;
  tokensPerSol: number;
  at: number;
}

let cache: CachedPrice | null = null;

export async function getPoolTokenUsdPrice(): Promise<{ usd: number; tokensPerSol: number } | null> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return { usd: cache.usd, tokensPerSol: cache.tokensPerSol };

  try {
    const url = `${JUP_QUOTE}?inputMint=${WSOL_MINT}&outputMint=${poolTokenMint()}&amount=${PROBE_LAMPORTS}&slippageBps=300`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return stale();
    const q = (await res.json()) as { outAmount?: string };
    const outTokens = Number(q.outAmount ?? 0) / 1e6; // token has 6 decimals
    if (!outTokens || !isFinite(outTokens)) return stale();
    const tokensPerSol = outTokens / 0.1;

    const { getMultiSourceValidatedPrice } = await import(
      '@/lib/services/market-data/unified-price-provider'
    );
    const sol = await getMultiSourceValidatedPrice('SOL', {
      minSources: 2,
      maxDeviationPercent: 2,
      timeout: 8000,
    });
    if (!sol.price || sol.price <= 0) return stale();

    const usd = sol.price / tokensPerSol;
    if (cache && Math.abs(usd - cache.usd) / cache.usd > MAX_JUMP_FRAC) {
      // Suspicious jump on a thin single-AMM market — keep serving the last
      // good price for one TTL rather than propagating a manipulated quote.
      cache = { ...cache, at: now };
      return { usd: cache.usd, tokensPerSol: cache.tokensPerSol };
    }
    cache = { usd, tokensPerSol, at: now };
    return { usd, tokensPerSol };
  } catch {
    return stale();
  }
}

function stale(): { usd: number; tokensPerSol: number } | null {
  return cache ? { usd: cache.usd, tokensPerSol: cache.tokensPerSol } : null;
}

/** Test hook — jest resets module registry between suites; prod never calls it. */
export function __resetPriceCacheForTests(): void {
  cache = null;
}
