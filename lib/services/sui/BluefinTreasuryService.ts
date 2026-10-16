/**
 * BluefinTreasuryService
 * ----------------------
 * Manages USDC movements between the operator's spot SUI wallet and Bluefin's
 * Margin Bank (V2 — `ExternalDataStore` architecture). Used to keep enough
 * free collateral in the perp account for the auto-hedge cron without manual
 * intervention.
 *
 * Why no SDK?
 * The official @bluefin-exchange/bluefin-v2-client SDK fetches its deployment
 * metadata from `https://dapi.api.sui-prod.bluefin.io/config`. That gateway is
 * decommissioned (returns Envoy `503 no healthy upstream`), so the SDK cannot
 * build deposit PTBs in production. Instead, we build the PTB directly using
 * `@mysten/sui` against the V2 `exchange::deposit_to_asset_bank` entry on the
 * known mainnet package. Contract config is sourced from the live
 * `/v1/exchange/info` endpoint with a hardcoded fallback.
 */

import { Transaction } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { logger } from '@/lib/utils/logger';
import { createFailoverSuiClient } from '@/lib/services/sui/sui-failover-transport';

// Native USDC on SUI Mainnet (Circle), 6 decimals.
const NATIVE_USDC_TYPE_MAINNET =
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

// Bluefin V2 mainnet contract IDs (verified on-chain). The /v1/exchange/info
// endpoint exposes these too — we fetch when reachable and fall back to these
// values when it 503s.
const BLUEFIN_V2_FALLBACK = {
  packageId: '0xe74481697f432ddee8dd6f9bd13b9d0297a5b63d55f3db25c4d3b5d34dad85b7',
  externalDataStore: '0x740d972ea066fe3302ee655163373cda2e9529bfa93d2266e1355cf56899da57',
  externalDataStoreInitialSharedVersion: 510828396,
  usdcType: NATIVE_USDC_TYPE_MAINNET,
  usdcSymbol: 'USDC',
} as const;

const EXCHANGE_INFO_URL = 'https://api.sui-prod.bluefin.io/v1/exchange/info';

export interface DepositResult {
  ok: boolean;
  amount: number;
  txDigest?: string;
  marginBalanceBefore?: number;
  marginBalanceAfter?: number;
  error?: string;
}

interface BluefinConfig {
  packageId: string;
  externalDataStore: string;
  externalDataStoreInitialSharedVersion: number;
  usdcType: string;
  usdcSymbol: string;
}

export class BluefinTreasuryService {
  private static instance: BluefinTreasuryService;
  private suiClient: SuiClient | null = null;
  private keypair: Ed25519Keypair | null = null;
  private walletAddress: string | null = null;
  private cachedConfig: BluefinConfig | null = null;
  private initPromise: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): BluefinTreasuryService {
    if (!BluefinTreasuryService.instance) {
      BluefinTreasuryService.instance = new BluefinTreasuryService();
    }
    return BluefinTreasuryService.instance;
  }

  private async ensureInit(): Promise<void> {
    if (this.keypair) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const pk = (process.env.BLUEFIN_PRIVATE_KEY || '').trim();
      if (!pk) throw new Error('BLUEFIN_PRIVATE_KEY not set');

      let secretKey: Uint8Array;
      try {
        ({ secretKey } = decodeSuiPrivateKey(pk));
      } catch (e) {
        throw new Error(`decodeSuiPrivateKey failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
      this.walletAddress = this.keypair.getPublicKey().toSuiAddress();
      this.suiClient = createFailoverSuiClient('mainnet');

      logger.info('[BluefinTreasury] initialized', { walletAddress: this.walletAddress });
    })().catch((e) => {
      this.initPromise = null;
      logger.error('[BluefinTreasury] init failed', { error: e instanceof Error ? e.message : String(e) });
      throw e;
    });

    return this.initPromise;
  }

  getAddress(): string | null {
    return this.walletAddress;
  }

  /** Pull mainnet config from Bluefin v1 API; fall back to hardcoded values. */
  private async getConfig(): Promise<BluefinConfig> {
    if (this.cachedConfig) return this.cachedConfig;
    try {
      const r = await fetch(EXCHANGE_INFO_URL);
      if (r.ok) {
        const j = (await r.json()) as {
          contractsConfig?: { currentContractAddress?: string; edsId?: string };
        };
        const pkg = j?.contractsConfig?.currentContractAddress;
        const eds = j?.contractsConfig?.edsId;
        if (pkg && eds) {
          // Initial shared version is fixed at object creation; we read it once.
          let edsVersion: number = BLUEFIN_V2_FALLBACK.externalDataStoreInitialSharedVersion;
          try {
            const info = await this.suiClient!.getObject({ id: eds, options: { showOwner: true } });
            const owner = info.data?.owner;
            if (owner && typeof owner === 'object' && 'Shared' in owner) {
              const v = (owner as { Shared?: { initial_shared_version?: number | string } }).Shared?.initial_shared_version;
              if (v !== undefined) edsVersion = Number(v);
            }
          } catch {
            /* keep fallback version */
          }
          this.cachedConfig = {
            packageId: pkg,
            externalDataStore: eds,
            externalDataStoreInitialSharedVersion: edsVersion,
            usdcType: NATIVE_USDC_TYPE_MAINNET,
            usdcSymbol: 'USDC',
          };
          return this.cachedConfig;
        }
      }
    } catch (e) {
      logger.warn('[BluefinTreasury] /v1/exchange/info fetch failed, using fallback', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    this.cachedConfig = { ...BLUEFIN_V2_FALLBACK };
    return this.cachedConfig;
  }

  /**
   * Free collateral on Bluefin for this wallet. Best-effort: queries Bluefin's
   * userAccountData API. Returns 0 if unreachable. The auto-hedge preflight
   * uses the Trade API for authoritative free-collateral checks.
   */
  async getMarginBalance(): Promise<number> {
    await this.ensureInit();
    try {
      const url = `https://api.sui-prod.bluefin.io/v1/exchange/userAccountData?address=${this.walletAddress}`;
      const r = await fetch(url);
      if (r.ok) {
        const j = (await r.json()) as { freeCollateral?: string | number; collateral?: string | number };
        const raw = j?.freeCollateral ?? j?.collateral;
        if (raw !== undefined) {
          const n = Number(raw);
          if (Number.isFinite(n)) {
            if (n > 1e9) return n / 1e9;
            if (n > 1e6) return n / 1e6;
            return n;
          }
        }
      }
    } catch {
      /* fall through */
    }
    return 0;
  }

  /** Spot USDC balance on the operator wallet (USDC) */
  async getSpotUsdcBalance(): Promise<number> {
    await this.ensureInit();
    if (!this.walletAddress) return 0;
    try {
      const bal = await this.suiClient!.getBalance({
        owner: this.walletAddress,
        coinType: NATIVE_USDC_TYPE_MAINNET,
      });
      const raw = bal?.totalBalance;
      if (!raw) return 0;
      return Number(BigInt(raw)) / 1_000_000;
    } catch (e) {
      logger.warn('[BluefinTreasury] getSpotUsdcBalance failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      return 0;
    }
  }

  /**
   * Deposit `amount` USDC from the operator's spot wallet into Bluefin V2
   * Margin Bank.
   *
   * Builds a PTB calling
   *   `${pkg}::exchange::deposit_to_asset_bank<USDC>(
   *      &mut ExternalDataStore, "USDC", account, amount_u64, &mut Coin<USDC>, ctx
   *   )`
   * The Coin<USDC> is split off the wallet's largest USDC coin so we don't
   * spend more than `amount`.
   */
  async deposit(amount: number): Promise<DepositResult> {
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, amount, error: 'amount must be a positive number' };
    }
    // Bluefin V2 enforces a 1 USDC minimum (abort code 1030 from
    // bank::deposit_to_asset_bank). Reject early to avoid wasted gas.
    if (amount < 1) {
      return { ok: false, amount, error: 'Bluefin minimum deposit is 1 USDC' };
    }
    await this.ensureInit();
    const before = await this.getMarginBalance().catch(() => undefined);
    try {
      const cfg = await this.getConfig();
      const account = this.walletAddress!;

      // 6 decimals
      const amountBase = BigInt(Math.round(amount * 1_000_000));

      // Pick a USDC coin with sufficient balance, otherwise merge.
      // The Move entry takes `&mut Coin<T>` and pulls out `amount` in-place,
      // so we MUST pass an actual coin object (not a `splitCoins` result),
      // and the coin must already hold ≥ amount.
      const coins = await this.suiClient!.getCoins({ owner: account, coinType: cfg.usdcType });
      if (!coins.data.length) throw new Error('No USDC coins on operator wallet');
      const sorted = [...coins.data].sort((a, b) =>
        BigInt(b.balance) > BigInt(a.balance) ? 1 : -1,
      );
      const total = sorted.reduce((s, c) => s + BigInt(c.balance), 0n);
      if (total < amountBase) {
        throw new Error(`Insufficient USDC: have ${Number(total) / 1e6}, need ${amount}`);
      }

      const tx = new Transaction();
      tx.setSender(account);

      // Use the largest USDC coin; merge in any others first if needed.
      const [primary, ...rest] = sorted;
      let coinArg: ReturnType<typeof tx.object>;
      if (BigInt(primary.balance) >= amountBase) {
        coinArg = tx.object(primary.coinObjectId);
      } else {
        // Need to merge to gather enough into `primary`.
        tx.mergeCoins(
          tx.object(primary.coinObjectId),
          rest.map((c) => tx.object(c.coinObjectId)),
        );
        coinArg = tx.object(primary.coinObjectId);
      }

      tx.moveCall({
        target: `${cfg.packageId}::exchange::deposit_to_asset_bank`,
        typeArguments: [cfg.usdcType],
        arguments: [
          tx.sharedObjectRef({
            objectId: cfg.externalDataStore,
            initialSharedVersion: cfg.externalDataStoreInitialSharedVersion,
            mutable: true,
          }),
          tx.pure.string(cfg.usdcSymbol),
          tx.pure.address(account),
          tx.pure.u64(amountBase),
          coinArg,
        ],
      });

      const result = await this.suiClient!.signAndExecuteTransaction({
        signer: this.keypair!,
        transaction: tx,
        options: { showEffects: true, showObjectChanges: false },
      });

      const status = result.effects?.status?.status;
      const ok = status === 'success';
      const txDigest = result.digest;

      try {
        await this.suiClient!.waitForTransaction({ digest: txDigest, timeout: 20_000 });
      } catch {
        /* non-fatal */
      }
      const after = await this.getMarginBalance().catch(() => undefined);

      logger.info('[BluefinTreasury] deposit result', {
        amount, ok, txDigest, before, after, status, error: result.effects?.status?.error,
      });
      // The money has moved; a failed record must not undo the result, but it must be seen.
      if (ok) {
        try {
          const { recordVenueCapital } = await import('@/lib/db/venue-capital');
          await recordVenueCapital('deposit', amount, txDigest);
        } catch (e) {
          logger.error('[BluefinTreasury] deposit landed but was not recorded in venue_capital', {
            amount, txDigest, error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      return {
        ok,
        amount,
        txDigest,
        marginBalanceBefore: before,
        marginBalanceAfter: after,
        error: ok ? undefined : (result.effects?.status?.error || `status=${status}`),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : (typeof err === 'string' ? err : JSON.stringify(err));
      logger.error('[BluefinTreasury] deposit failed', { amount, error: msg });
      return { ok: false, amount, marginBalanceBefore: before, error: msg };
    }
  }

  /**
   * Best-effort swap of SUI → USDC on the operator wallet via the official
   * Bluefin 7k aggregator SDK (used directly so we can constrain `sources`
   * and retry with restricted DEX sets if a routed pool is paused).
   *
   * Returns the realised USDC delta (in human units) on success; 0 on failure.
   */
  private async swapSuiToUsdc(suiAmount: number): Promise<{
    ok: boolean;
    usdcDelta: number;
    txDigest?: string;
    error?: string;
  }> {
    if (!Number.isFinite(suiAmount) || suiAmount <= 0) {
      return { ok: false, usdcDelta: 0, error: 'invalid suiAmount' };
    }
    try {
      const { getQuote: get7kQuote, buildTx: build7kTx, Config: BluefinSwapConfig } = await import(
        '@bluefin-exchange/bluefin7k-aggregator-sdk'
      );

      // Configure the SDK with our SuiClient (needed for buildTx)
      try { (BluefinSwapConfig as { setSuiClient: (c: unknown) => void }).setSuiClient(this.suiClient); } catch { /* ignore */ }

      const SUI_TYPE = '0x2::sui::SUI';
      const USDC_TYPE = NATIVE_USDC_TYPE_MAINNET;
      const amountIn = BigInt(Math.round(suiAmount * 1e9)).toString(); // SUI 9dp
      const sender = this.walletAddress!;

      // Try a sequence of progressively-restricted source sets so we route
      // around paused pools without exposing private exclusion lists.
      const sourceFallbacks: Array<string[] | undefined> = [
        undefined,                                               // default
        ['cetus', 'bluefin', 'deepbook_v3'],                     // big healthy AMMs
        ['bluefin'],                                             // bluefin native
        ['cetus'],                                               // cetus only
        ['deepbook_v3'],                                         // deepbook only
      ];

      const usdcBefore = await this.getSpotUsdcBalance();
      let lastError: string | undefined;

      for (const sources of sourceFallbacks) {
        let quoteResp;
        try {
          quoteResp = await (get7kQuote as (p: {
            tokenIn: string; tokenOut: string; amountIn: string; sources?: string[];
          }) => Promise<{ returnAmount?: string }>)({
            tokenIn: SUI_TYPE,
            tokenOut: USDC_TYPE,
            amountIn,
            ...(sources ? { sources } : {}),
          });
        } catch (qe) {
          lastError = `quote failed: ${qe instanceof Error ? qe.message : String(qe)}`;
          continue;
        }
        if (!quoteResp || !quoteResp.returnAmount || quoteResp.returnAmount === '0') {
          lastError = 'no route found';
          continue;
        }

        let buildResult;
        try {
          buildResult = await (build7kTx as (p: {
            quoteResponse: unknown; accountAddress: string; slippage: number;
            commission: { partner: string; commissionBps: number };
          }) => Promise<{ tx: unknown }>)({
            quoteResponse: quoteResp,
            accountAddress: sender,
            slippage: 0.02,
            commission: { partner: sender, commissionBps: 0 },
          });
        } catch (be) {
          lastError = `buildTx failed: ${be instanceof Error ? be.message : String(be)}`;
          continue;
        }

        const tx = buildResult.tx as { setSender: (a: string) => void; setGasBudget: (n: number) => void };
        try {
          tx.setSender(sender);
          tx.setGasBudget(50_000_000); // 0.05 SUI
        } catch { /* ignore */ }

        let result;
        try {
          result = await this.suiClient!.signAndExecuteTransaction({
            signer: this.keypair!,
            transaction: tx as never,
            options: { showEffects: true },
          });
        } catch (xe) {
          lastError = `execute failed: ${xe instanceof Error ? xe.message : String(xe)}`;
          continue;
        }

        const status = result.effects?.status?.status;
        if (status === 'success') {
          try { await this.suiClient!.waitForTransaction({ digest: result.digest, timeout: 20_000 }); } catch { /* ignore */ }
          const usdcAfter = await this.getSpotUsdcBalance();
          return {
            ok: true,
            usdcDelta: Math.max(0, usdcAfter - usdcBefore),
            txDigest: result.digest,
          };
        } else {
          const errStr = result.effects?.status?.error || `status=${status}`;
          lastError = `tx aborted: ${errStr}`;
          // Only retry with different sources for pause-style failures
          if (!/assert_not_pause|paused|MoveAbort/i.test(errStr)) break;
        }
      }

      return { ok: false, usdcDelta: 0, error: lastError || 'all sources exhausted' };
    } catch (e) {
      return { ok: false, usdcDelta: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Auto top-up: ensure marginBalance >= minMargin by depositing up to targetMargin.
   * Caps the deposit by available spot USDC (minus a small reserve for gas/fees).
   *
   * If `swapFromSui=true` and the operator's spot USDC is insufficient, the
   * service will swap a portion of SUI → USDC via BluefinAggregatorService
   * before depositing — keeping the hedge margin funded automatically as
   * users deposit (their SUI flows to the operator via pool admin operations,
   * and we convert just enough to back the perp short).
   */
  async autoTopUp(opts: {
    minMargin: number;
    targetMargin: number;
    spotReserve?: number;
    swapFromSui?: boolean;
    suiReserve?: number;       // SUI to keep on operator wallet for gas
    maxSwapSui?: number;       // safety cap per autoTopUp run
  }): Promise<
    | DepositResult
    | { skipped: true; reason: string; marginBalance: number; spotUsdc: number }
    | (DepositResult & { swap?: { txDigest?: string; usdcDelta: number } })
  > {
    await this.ensureInit();
    const margin = await this.getMarginBalance();
    if (margin >= opts.minMargin) {
      return { skipped: true, reason: 'margin above floor', marginBalance: margin, spotUsdc: 0 };
    }
    const reserve = Math.max(0, opts.spotReserve ?? 0);
    let spot = await this.getSpotUsdcBalance();
    let usable = Math.max(0, spot - reserve);
    const need = Math.max(0, opts.targetMargin - margin);

    let swap: { txDigest?: string; usdcDelta: number; error?: string; suiToSwap?: number; suiHuman?: number; spendableSui?: number } | undefined;

    // If we don't have enough USDC and swap-from-SUI is enabled, top up via DEX.
    if (usable < Math.min(need, 1) && opts.swapFromSui) {
      // Check SUI balance via direct RPC
      let suiHuman = 0;
      try {
        const bal = await this.suiClient!.getBalance({ owner: this.walletAddress! });
        suiHuman = Number(BigInt(bal.totalBalance)) / 1e9;
      } catch {
        /* best-effort */
      }
      const suiReserve = Math.max(0, opts.suiReserve ?? 0.5);   // keep for gas
      const spendableSui = Math.max(0, suiHuman - suiReserve);
      swap = { usdcDelta: 0, suiHuman, spendableSui };
      if (spendableSui > 0) {
        // Estimate USDC missing → SUI to swap, capped by spendableSui & maxSwapSui.
        // Use last-known SUI price ($2 fallback) — we just need an approximate amount.
        let suiPriceUsd = 2;
        try {
          const { getMarketDataService } = await import('@/lib/services/market-data/RealMarketDataService');
          const p = await getMarketDataService().getTokenPrice('SUI');
          if (p?.price && p.price > 0) suiPriceUsd = p.price;
        } catch {
          /* ignore */
        }
        const usdcShortfall = Math.max(1, need - usable + 0.5); // 0.5 buffer for slippage
        let suiToSwap = usdcShortfall / suiPriceUsd;
        if (typeof opts.maxSwapSui === 'number' && opts.maxSwapSui > 0) {
          suiToSwap = Math.min(suiToSwap, opts.maxSwapSui);
        }
        suiToSwap = Math.min(suiToSwap, spendableSui);
        suiToSwap = Math.floor(suiToSwap * 1000) / 1000; // 3dp
        if (suiToSwap >= 0.01) {
          const sw = await this.swapSuiToUsdc(suiToSwap);
          swap = { ...(swap ?? { usdcDelta: 0 }), txDigest: sw.txDigest, usdcDelta: sw.usdcDelta, error: sw.error, suiToSwap };
          if (sw.ok) {
            // Refresh USDC view
            spot = await this.getSpotUsdcBalance();
            usable = Math.max(0, spot - reserve);
            logger.info('[BluefinTreasury] swapped SUI → USDC for top-up', {
              suiToSwap, usdcDelta: sw.usdcDelta, txDigest: sw.txDigest,
            });
          } else {
            logger.warn('[BluefinTreasury] SUI→USDC swap failed', { error: sw.error });
          }
        }
      }
    }

    if (usable <= 0) {
      return { skipped: true, reason: 'no spendable spot USDC', marginBalance: margin, spotUsdc: spot, swap } as unknown as { skipped: true; reason: string; marginBalance: number; spotUsdc: number };
    }
    const amount = Math.min(usable, need);
    if (amount < 1) {
      return { skipped: true, reason: 'top-up amount < 1 USDC', marginBalance: margin, spotUsdc: spot, swap } as unknown as { skipped: true; reason: string; marginBalance: number; spotUsdc: number };
    }
    const rounded = Math.floor(amount * 100) / 100;
    const dep = await this.deposit(rounded);
    return swap ? { ...dep, swap } : dep;
  }
}

export const bluefinTreasury = BluefinTreasuryService.getInstance();
