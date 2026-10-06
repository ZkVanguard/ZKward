/**
 * BlueFin Pro Perpetual DEX Integration for SUI
 *
 * BlueFin is the leading orderbook-based perpetual exchange on SUI Network.
 * This service provides hedge execution via BlueFin Pro REST API.
 *
 * AUTHENTICATION (No API Keys - Wallet Signature Only):
 * - POST /auth/v2/token with BCS-encoded payload signature
 * - Body: { accountAddress, signedAtMillis, audience }
 * - Header: payloadSignature (BCS signature with intent bytes)
 * - Returns JWT tokens for authenticated requests
 *
 * RATE LIMITS:
 * - auth.api: 30 RPM (token requests)
 * - api: 300 RPM (pro services except trading)
 * - stream.api: 50 RPM (websocket)
 * - trade.api: 500 RPM (trading gateway)
 *
 * ENDPOINTS:
 * - Auth API: https://auth.api.{env}.bluefin.io/auth/v2/token
 * - Trade API: https://trade.api.{env}.bluefin.io/api/v1/ (orders, account)
 * - Exchange API: https://api.{env}.bluefin.io/v1/exchange/ (market data, orderbook)
 *
 * Order Fields (e9 scaling - 1e9 = 1.0):
 * - price_e9: Price in e9 format
 * - quantity_e9: Size in e9 format
 * - leverage_e9: Leverage in e9 format (2x = 2000000000)
 *
 * @see https://bluefin-exchange.readme.io/reference/post_auth-v2-token
 * @see https://bluefin-exchange.readme.io/reference/postcreateorder
 */

import { logger } from '@/lib/utils/logger';
import { signOrderRequest, type OrderSignedFields } from '@/lib/services/sui/bluefin/sign-request';
import {
  fetchMarketData, fetchOrderBook, fetchFundingRates,
  type ExchangeApiCaller,
} from '@/lib/services/sui/bluefin/market-data';
import { performDryRunHedge, type DryRunParams, type DryRunResult } from '@/lib/services/sui/bluefin/dry-run-hedge';
import { performOpenHedge } from '@/lib/services/sui/bluefin/open-hedge-impl';
import { performCloseHedge } from '@/lib/services/sui/bluefin/close-hedge-impl';
import { parseAccountPosition } from '@/lib/services/sui/bluefin-ticker-parsers';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// Network configurations - Updated per BlueFin Pro API docs
export const BLUEFIN_NETWORKS = {
  mainnet: {
    name: 'SUI Mainnet',
    rpcUrl: 'https://fullnode.mainnet.sui.io:443',
    // Auth API for JWT tokens (30 RPM)
    authApiUrl: 'https://auth.api.sui-prod.bluefin.io',
    // Exchange API for market data (300 RPM) - uses /v1/exchange/ paths
    exchangeApiUrl: 'https://api.sui-prod.bluefin.io',
    // Trade API for orders/accounts (500 RPM) - uses /api/v1/ paths
    tradeApiUrl: 'https://trade.api.sui-prod.bluefin.io',
    // WebSocket streams (50 RPM for connection)
    wsUrl: 'wss://stream.api.sui-prod.bluefin.io',
    chainId: 'mainnet',
    // IDS (Independent Data Store) object address from exchange/info contractsConfig
    idsId: '0xa9f033047d2fc453da063b03500a48950d2497bb0a2faec57da2833d42a12806',
    // Audience must be 'api' per SDK source code
    audience: 'api',
  },
  testnet: {
    name: 'SUI Testnet',
    rpcUrl: 'https://fullnode.testnet.sui.io:443',
    // Staging/testnet endpoints
    authApiUrl: 'https://auth.api.sui-staging.bluefin.io',
    exchangeApiUrl: 'https://api.sui-staging.bluefin.io',
    tradeApiUrl: 'https://trade.api.sui-staging.bluefin.io',
    wsUrl: 'wss://stream.api.sui-staging.bluefin.io',
    chainId: 'testnet',
    // IDS (Independent Data Store) object address from exchange/info contractsConfig
    idsId: '0xf19acdacbd086641c7a316d23617fa18bba5d95dab8a02c1281538104f3d4040',
    // Audience must be 'api' per SDK source code
    audience: 'api',
  },
} as const;

// Supported trading pairs on BlueFin
export const BLUEFIN_PAIRS = {
  'BTC-PERP': {
    index: 0,
    symbol: 'BTC-PERP',
    baseAsset: 'BTC',
    maxLeverage: 10,
    minQuantity: 0.001,
    stepSize: 0.001,
  },
  'ETH-PERP': {
    index: 1,
    symbol: 'ETH-PERP',
    baseAsset: 'ETH',
    maxLeverage: 10,
    minQuantity: 0.01,
    stepSize: 0.01,
  },
  'SUI-PERP': {
    index: 2,
    symbol: 'SUI-PERP',
    baseAsset: 'SUI',
    maxLeverage: 20,
    minQuantity: 1,
    stepSize: 1,
  },
  'SOL-PERP': {
    index: 3,
    symbol: 'SOL-PERP',
    baseAsset: 'SOL',
    maxLeverage: 20,
    minQuantity: 0.1,
    stepSize: 0.1,
  },
  'GOLD-PERP': {
    index: 4,
    symbol: 'GOLD-PERP',
    baseAsset: 'GOLD',
    maxLeverage: 2,
    minQuantity: 0.01,
    stepSize: 0.01,
  },
  'HYPE-PERP': {
    index: 5,
    symbol: 'HYPE-PERP',
    baseAsset: 'HYPE',
    maxLeverage: 10,
    minQuantity: 0.1,
    stepSize: 0.1,
  },
  'DEEP-PERP': {
    index: 6,
    symbol: 'DEEP-PERP',
    baseAsset: 'DEEP',
    maxLeverage: 10,
    minQuantity: 1,
    stepSize: 1,
  },
  'WAL-PERP': {
    index: 7,
    symbol: 'WAL-PERP',
    baseAsset: 'WAL',
    maxLeverage: 10,
    minQuantity: 1,
    stepSize: 1,
  },
} as const;

// Order types
export enum BluefinOrderType {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
}

export enum BluefinSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

// Position interface
export interface BluefinPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  margin: number;
  marginRatio: number;
}

// Order interface
export interface BluefinOrder {
  orderId: string;
  symbol: string;
  side: BluefinSide;
  type: BluefinOrderType;
  size: number;
  price?: number;
  leverage: number;
  reduceOnly: boolean;
  postOnly: boolean;
  timeInForce: 'GTC' | 'IOC' | 'FOK';
}

// Hedge execution result
export interface BluefinHedgeResult {
  success: boolean;
  hedgeId: string;
  orderId?: string;
  txDigest?: string;
  executionPrice?: number;
  filledSize?: number;
  fees?: number;
  error?: string;
  /**
   * Machine-readable error code for callers that want to branch on failure
   * category instead of parsing the error string. Values:
   *   - 'DUST_LOCKED'         — position size < minQty; unclosable via reduce
   *   - 'DUST_RISK'           — open size below OPEN_MIN_QTY_BUFFER × minQty
   *   - 'BELOW_MIN_QTY'       — pre-snap size < minQty
   *   - 'BELOW_MIN_QTY_SNAPPED'— post-snap size < minQty
   *   - 'LEVERAGE_EXCEEDED'   — leverage > maxLeverage for symbol
   *   - 'NO_MARKET_PRICE'     — market data fetch failed
   *   - 'NO_POSITION'         — close called with nothing on venue
   *   - 'SILENT_REJECT'       — venue returned orderHash but position
   *     didn't move (matching engine dropped the order silently, usually
   *     from a free-collateral shortfall on the closing side)
   *   - 'VENUE_ERROR'         — non-classified BlueFin API failure
   */
  code?:
    | 'DUST_LOCKED'
    | 'DUST_RISK'
    | 'BELOW_MIN_QTY'
    | 'BELOW_MIN_QTY_SNAPPED'
    | 'LEVERAGE_EXCEEDED'
    | 'NO_MARKET_PRICE'
    | 'NO_POSITION'
    | 'SILENT_REJECT'
    | 'VENUE_ERROR';
  /** Structured dust classification — populated when code is DUST_LOCKED / DUST_RISK. */
  dust?: {
    positionSize: number;
    minQty: number;
    stepSize: number;
    stepMultiples: number;
  };
  timestamp: number;
  /** Raw BlueFin API response — only populated on close failures for diagnosis. */
  rawResponse?: unknown;
  /** Pre/post position sizes — populated when a close was attempted. */
  preCloseSize?: number;
  postCloseSize?: number;
}

/**
 * BlueFin Service - Handles all interactions with BlueFin DEX
 *
 * Authentication: Wallet signature to get JWT token (no API keys)
 * Rate limiting: Built-in with exponential backoff on 429, respects Retry-After header
 */
export class BluefinService {
  private static instance: BluefinService;
  private initialized: boolean = false;
  private network: 'mainnet' | 'testnet' = 'mainnet';
  private keypair: Ed25519Keypair | null = null;
  private walletAddress: string | null = null;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt: number = 0;

  // Rate limiting state — per-endpoint to prevent one 429 from blocking all requests
  private lastRequestTime: Map<string, number> = new Map();
  private rateLimitRetryAfter: Map<string, number> = new Map();

  // Initialization lock to prevent concurrent init race condition
  private initPromise: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): BluefinService {
    if (!BluefinService.instance) {
      BluefinService.instance = new BluefinService();
    }
    return BluefinService.instance;
  }

  /**
   * Get service status for diagnostics
   */
  getStatus(): {
    initialized: boolean;
    network: string;
    walletAddress: string | null;
    authenticated: boolean;
  } {
    return {
      initialized: this.initialized,
      network: this.network,
      walletAddress: this.walletAddress,
      authenticated: !!this.accessToken,
    };
  }

  /**
   * Initialize BlueFin client with SUI wallet private key
   * BlueFin Pro uses wallet signature auth (no API keys needed)
   */
  async initialize(privateKey: string, network: 'mainnet' | 'testnet' = 'mainnet'): Promise<void> {
    if (this.initialized && this.network === network) {
      return;
    }

    // Prevent concurrent initialization race condition
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._doInitialize(privateKey, network).finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async _doInitialize(privateKey: string, network: 'mainnet' | 'testnet'): Promise<void> {
    // Sanitize inputs (Vercel env vars on Windows can have trailing \r\n)
    const cleanNetwork = network.trim() as 'mainnet' | 'testnet';
    privateKey = privateKey.trim();

    // H1: If switching networks, reset auth state to prevent cross-network token usage
    if (this.initialized && this.network !== cleanNetwork) {
      logger.warn('[BlueFin] Network switch detected', { from: this.network, to: cleanNetwork });
      this.accessToken = null;
      this.refreshToken = null;
      this.tokenExpiresAt = 0;
      this.initialized = false;
    }

    try {
      const networkConfig = BLUEFIN_NETWORKS[cleanNetwork];
      if (!networkConfig) {
        throw new Error(
          `Unknown BlueFin network: '${cleanNetwork}'. Must be 'mainnet' or 'testnet'.`
        );
      }

      logger.info('🌊 Initializing BlueFin Pro client', {
        network: cleanNetwork,
        authApi: networkConfig.authApiUrl,
        tradeApi: networkConfig.tradeApiUrl,
      });

      // Parse private key - supports bech32 (suiprivkey...) or hex formats
      if (privateKey.startsWith('suiprivkey')) {
        const { secretKey } = decodeSuiPrivateKey(privateKey);
        this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
      } else {
        // Hex format
        const hexKey = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
        const keyBytes = Buffer.from(hexKey, 'hex');
        this.keypair = Ed25519Keypair.fromSecretKey(keyBytes);
      }

      this.walletAddress = this.keypair.toSuiAddress();
      this.network = cleanNetwork;

      // Try to authenticate with BlueFin API
      const authSuccess = await this.authenticate();

      if (!authSuccess) {
        // Do NOT mark this client as initialized when auth failed — otherwise
        // the singleton looks ready and subsequent getBalance/getPositions
        // calls hit an unauthenticated client, where apiRequest silently
        // surfaces 401s as `null` and getBalance returns 0. That's the cold-
        // lambda "fake zero NAV" failure mode. Throw so ensureInitializedAsync
        // retries auth on the next call, and so explicit init() paths surface
        // the failure to their fallback logic.
        throw new Error('BlueFin auth failed during initialize — refusing to mark initialized');
      }

      // C4: Verify account is onboarded (fail-fast at init, not at first trade)
      if (authSuccess) {
        try {
          const acctResp = await this.apiRequest<Record<string, unknown> | null>(
            'GET',
            `/api/v1/account?accountAddress=${this.walletAddress}`,
            undefined,
            'exchange'
          );
          if (!acctResp) {
            logger.warn(
              `⚠️ BlueFin account ${this.walletAddress} may not be onboarded on ${cleanNetwork}`
            );
          } else {
            const e9 = acctResp.marginAvailableE9;
            const free =
              e9 !== undefined && e9 !== null
                ? (parseFloat(String(e9)) / 1e9).toFixed(6)
                : String(acctResp.freeCollateral ?? '0');
            logger.info('✅ BlueFin account verified', {
              canTrade: acctResp.canTrade,
              freeCollateral: free,
            });
          }
        } catch (acctErr) {
          const msg = acctErr instanceof Error ? acctErr.message : String(acctErr);
          if (msg.includes('404') || msg.includes('not found')) {
            logger.error(
              `❌ BlueFin account ${this.walletAddress} NOT onboarded on ${cleanNetwork}. Visit https://trade.bluefin.io to register.`
            );
          } else {
            logger.warn('⚠️ Could not verify BlueFin account onboarding', { error: msg });
          }
        }
      }

      this.initialized = true;
      logger.info('✅ BlueFin client initialized', {
        network: cleanNetwork,
        address: this.walletAddress,
        authenticated: authSuccess,
      });
    } catch (error) {
      logger.error(
        '❌ Failed to initialize BlueFin client',
        error instanceof Error ? error : undefined
      );
      throw new Error(
        `BlueFin initialization failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Authenticate with BlueFin Pro /auth/v2/token endpoint
   * Uses SUI signPersonalMessage for wallet signature authentication
   * Returns true if authentication succeeded
   *
   * Rate limit: 30 RPM on auth.api
   */
  private async authenticate(): Promise<boolean> {
    if (!this.keypair) return false;

    const networkConfig = BLUEFIN_NETWORKS[this.network];

    try {
      const signedAtMillis = Date.now();
      const audience = networkConfig.audience;

      // Create the auth payload per SDK format
      const authPayload = {
        accountAddress: this.walletAddress,
        signedAtMillis,
        audience,
      };

      // Serialize payload for signing
      const payloadString = JSON.stringify(authPayload);
      const messageBytes = new TextEncoder().encode(payloadString);

      // Sign using SUI's signPersonalMessage which handles:
      // - BCS encoding message as vector<u8>
      // - Adding PersonalMessage intent prefix
      // - Blake2b hashing
      // - Creating serialized signature (flag + signature + pubkey in base64)
      const { signature: payloadSignature } = await this.keypair.signPersonalMessage(messageBytes);

      logger.debug('BlueFin Pro auth attempt', {
        address: this.walletAddress,
        network: this.network,
        authUrl: `${networkConfig.authApiUrl}/auth/v2/token`,
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      let response: Response;
      try {
        response = await fetch(`${networkConfig.authApiUrl}/auth/v2/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            payloadSignature: payloadSignature,
          },
          body: payloadString,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
        this.rateLimitRetryAfter.set('auth', Date.now() + Math.min(retryAfter, 60) * 1000);
        logger.warn('BlueFin auth rate limited', { retryAfter });
        return false;
      }

      if (!response.ok) {
        const errorText = await response.text();
        logger.warn('BlueFin Pro auth failed', {
          status: response.status,
          error: errorText.slice(0, 200),
          network: this.network,
        });
        return false;
      }

      const data = await response.json();
      this.accessToken = data.accessToken || data.token;
      this.refreshToken = data.refreshToken;

      // Token typically valid for 30 days, but refresh before expiry
      if (data.expiresIn) {
        this.tokenExpiresAt = Date.now() + data.expiresIn * 1000 - 60000; // Refresh 1 min early
      } else {
        this.tokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000; // Default 24 hours
      }

      if (this.accessToken) {
        logger.info('✅ BlueFin Pro authentication successful');
        return true;
      }

      logger.warn('BlueFin Pro: No token in response');
      return false;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.debug('BlueFin Pro auth error', { error: errMsg });
      return false;
    }
  }

  /**
   * Ensure we have a valid access token, refreshing if needed
   */
  private async ensureValidToken(): Promise<boolean> {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
      return await this.authenticate();
    }
    return true;
  }

  /**
   * Sign order fields — delegates to the extracted signOrderRequest
   * primitive in @/lib/services/sui/bluefin/sign-request. Kept as a thin
   * wrapper so the existing 3 call sites (line ~1289, 1562, 1710) don't
   * need to know about the signer parameter.
   */
  private async signOrderFields(signedFields: OrderSignedFields): Promise<string> {
    if (!this.keypair) throw new Error('Keypair not initialized');
    return signOrderRequest(this.keypair, signedFields);
  }

  /**
   * Admin-only escape hatch: invoke the authenticated apiRequest from outside
   * the service. Used by /api/admin/bluefin-prefs to inspect / write per-symbol
   * preferences (which the SDK exposes but our service wraps minimally). Do
   * NOT use this for production paths — add a typed method for whatever the
   * real flow needs.
   */
  async adminRawApiRequest<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    apiType: 'trade' | 'exchange' = 'trade'
  ): Promise<T> {
    await this.ensureInitializedAsync();
    return this.apiRequest<T>(method, path, body, apiType);
  }

  /**
   * Make authenticated API request to BlueFin Trade API
   * Handles rate limiting with exponential backoff, auto-retry on 429 and 5xx errors
   *
   * Rate limit: 500 RPM on trade.api
   */
  private async apiRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    apiType: 'trade' | 'exchange' = 'trade'
  ): Promise<T> {
    const MAX_RETRIES = 3;
    let lastError: Error | null = null;
    const rateLimitKey = `${apiType}:${path.split('?')[0]}`;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Wait if rate limited (per-endpoint, capped at 60s max)
      const retryAfterTs = this.rateLimitRetryAfter.get(rateLimitKey) || 0;
      if (Date.now() < retryAfterTs) {
        const waitMs = Math.min(retryAfterTs - Date.now(), 60000);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, waitMs + Math.random() * 1000));
        } else {
          throw new Error(
            `Rate limited on ${rateLimitKey}. Retry after ${Math.ceil(waitMs / 1000)} seconds`
          );
        }
      }

      // Ensure we have a valid token
      await this.ensureValidToken();

      const networkConfig = BLUEFIN_NETWORKS[this.network];
      const baseUrl =
        apiType === 'exchange' ? networkConfig.exchangeApiUrl : networkConfig.tradeApiUrl;
      const url = `${baseUrl}${path}`;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      // Add auth token if available
      if (this.accessToken) {
        headers['Authorization'] = `Bearer ${this.accessToken}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        const requestBody = method !== 'GET' && body ? JSON.stringify(body) : undefined;
        const response = await fetch(url, {
          method,
          headers,
          body: requestBody,
          signal: controller.signal,
        });

        // Handle rate limiting (429) — auto-retry with Retry-After
        if (response.status === 429) {
          const retryAfter = Math.min(
            parseInt(response.headers.get('Retry-After') || '60', 10),
            60
          );
          this.rateLimitRetryAfter.set(rateLimitKey, Date.now() + retryAfter * 1000);
          if (attempt < MAX_RETRIES) {
            logger.debug('BlueFin API rate limited, retrying...', { attempt, retryAfter, path });
            await new Promise((r) => setTimeout(r, retryAfter * 1000 + Math.random() * 1000));
            continue;
          }
          logger.warn('BlueFin API rate limited after max retries', { retryAfter, path });
          throw new Error(`Rate limited. Retry after ${retryAfter} seconds`);
        }

        // Server errors (5xx) — auto-retry with exponential backoff
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          const backoff = Math.pow(2, attempt - 1) * 1000;
          logger.debug('BlueFin API server error, retrying...', {
            attempt,
            status: response.status,
            path,
          });
          await new Promise((r) => setTimeout(r, backoff + Math.random() * 1000));
          continue;
        }

        // 401 UNAUTHORIZED — the venue rejected our JWT even though
        // `ensureValidToken()` thought it was fresh (tokenExpiresAt vs
        // server truth can drift by TTL grace / server-side revocation
        // / clock skew). Force a full re-authentication and retry.
        // Observed 2026-07-13: openHedge failed repeatedly with
        // "401 - Jwt is expired" because tokenExpiresAt hadn't lapsed
        // yet from the client's view, so ensureValidToken was a no-op.
        if (response.status === 401 && attempt < MAX_RETRIES) {
          logger.warn('BlueFin API 401 — forcing re-auth + retry', { attempt, path });
          this.accessToken = null;
          this.tokenExpiresAt = 0;
          await this.authenticate();
          continue;
        }

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`BlueFin API error: ${response.status} - ${error}`);
        }

        return response.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Retry on network/timeout errors
        const isRetryable =
          lastError.message.includes('aborted') ||
          lastError.message.includes('network') ||
          lastError.message.includes('ECONNRESET') ||
          lastError.message.includes('fetch failed');
        if (isRetryable && attempt < MAX_RETRIES) {
          const backoff = Math.pow(2, attempt - 1) * 1000;
          logger.debug('BlueFin API transient error, retrying...', {
            attempt,
            error: lastError.message,
            path,
          });
          await new Promise((r) => setTimeout(r, backoff + Math.random() * 1000));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError || new Error('BlueFin API: max retries exceeded');
  }

  /**
   * Check if client is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get wallet address
   */
  getAddress(): string | null {
    return this.walletAddress;
  }

  /**
   * Get account balance (free collateral, USDC).
   * Bluefin Pro returns `marginAvailableE9` in E9 format on the exchange API.
   */
  async getBalance(): Promise<number> {
    await this.ensureInitializedAsync();

    try {
      const data = await this.apiRequest<Record<string, unknown>>(
        'GET',
        `/api/v1/account?accountAddress=${this.walletAddress}`,
        undefined,
        'exchange'
      );
      const e9 = data?.marginAvailableE9;
      if (e9 !== undefined && e9 !== null) {
        const n = parseFloat(String(e9));
        return Number.isFinite(n) ? n / 1e9 : 0;
      }
      // Fallback for older / staging response shape
      return parseFloat(String(data?.freeCollateral ?? '0')) || 0;
    } catch (error) {
      logger.error('Failed to get BlueFin balance', error instanceof Error ? error : undefined);
      return 0;
    }
  }

  /**
   * Total value of the venue account in USDC, as the venue computes it:
   * deposited balance plus unrealized P&L of every position.
   *
   * This is the figure for NAV. Free collateral plus position margin plus
   * unrealized P&L is not: for a cross-margin position the free collateral
   * already has that position's P&L in it, so the sum counts it twice.
   * Throws when the venue does not give the figure: a caller pricing the pool
   * must not mistake "unknown" for zero.
   */
  async getAccountValue(): Promise<number> {
    await this.ensureInitializedAsync();
    const data = await this.apiRequest<Record<string, unknown>>(
      'GET',
      `/api/v1/account?accountAddress=${this.walletAddress}`,
      undefined,
      'exchange'
    );
    const e9 = data?.totalAccountValueE9;
    const n = e9 === undefined || e9 === null ? NaN : parseFloat(String(e9));
    if (!Number.isFinite(n)) throw new Error('venue account value missing from the account response');
    return n / 1e9;
  }

  /**
   * Get all open positions from account data.
   *
   * Bluefin Pro returns numeric fields in E9 format (multiplied by 1e9, as
   * decimal strings). Field mapping lives in `parseAccountPosition`.
   *
   * Uses Exchange API: /api/v1/account
   */
  async getPositions(): Promise<BluefinPosition[]> {
    await this.ensureInitializedAsync();

    try {
      const account = await this.apiRequest<{
        positions?: Array<Record<string, unknown>>;
      }>('GET', `/api/v1/account?accountAddress=${this.walletAddress}`, undefined, 'exchange');

      return (account?.positions || []).map(parseAccountPosition);
    } catch (error) {
      logger.debug('Failed to get BlueFin positions', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get open orders from Trade API
   * Uses Trade API: /api/v1/trade/openOrders
   */
  async getOpenOrders(): Promise<
    Array<{
      orderId: string;
      symbol: string;
      side: string;
      price: number;
      quantity: number;
      status: string;
    }>
  > {
    await this.ensureInitializedAsync();

    try {
      const orders = await this.apiRequest<Array<Record<string, unknown>>>(
        'GET',
        '/api/v1/trade/openOrders',
        undefined,
        'trade'
      );
      return (orders || []).map((o) => ({
        orderId: (o.orderId as string) || (o.orderHash as string),
        symbol: o.symbol as string,
        side: o.side as string,
        price: parseFloat((o.price as string) || '0'),
        quantity: parseFloat((o.quantity as string) || '0'),
        status: (o.status as string) || 'OPEN',
      }));
    } catch (error) {
      logger.debug('Failed to get BlueFin open orders', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Bound reference to apiRequest with exchange-api signature — for
   *  passing to the extracted market-data functions in bluefin/market-data.ts. */
  private get exchangeApi(): ExchangeApiCaller {
    return this.apiRequest.bind(this) as unknown as ExchangeApiCaller;
  }

  /** Get market data for a symbol. Delegates to bluefin/market-data.fetchMarketData. */
  async getMarketData(symbol: string): Promise<{
    price: number; fundingRate: number; change24h?: number; openInterestUsd?: number;
  } | null> {
    await this.ensureInitializedAsync();
    return fetchMarketData(this.exchangeApi, symbol);
  }

  /**
   * Open a hedge position on BlueFin. Impl lives in bluefin/open-hedge-impl.ts
   * as a pure orchestrator; this method just binds the context and delegates.
   */
  async openHedge(params: {
    symbol: string;
    side: 'LONG' | 'SHORT';
    size: number;
    leverage: number;
    portfolioId?: number;
    reason?: string;
    bypassFundingGuard?: boolean;
    bypassOiGuard?: boolean;
    clientOrderId?: string;
  }): Promise<BluefinHedgeResult> {
    await this.ensureInitializedAsync();
    return performOpenHedge(
      {
        walletAddress: this.walletAddress,
        network: this.network,
        apiRequest: this.apiRequest.bind(this),
        getPositions: this.getPositions.bind(this),
        getMarketData: this.getMarketData.bind(this),
        signOrder: this.signOrderFields.bind(this),
      },
      params,
    );
  }


  /** Dry-run validation of a hedge — delegates to bluefin/dry-run-hedge. */
  async dryRunHedge(params: DryRunParams): Promise<DryRunResult> {
    await this.ensureInitializedAsync();
    return performDryRunHedge(
      {
        accessToken: this.accessToken,
        walletAddress: this.walletAddress,
        network: this.network,
        apiRequest: this.apiRequest.bind(this),
        getMarketData: this.getMarketData.bind(this),
        signOrder: this.signOrderFields.bind(this),
      },
      params,
    );
  }

  /**
   * Close a hedge position on BlueFin
   * Uses wallet signature authentication per BlueFin API docs
   */
  /**
   * Close a hedge position on BlueFin. Impl lives in bluefin/close-hedge-impl.ts
   * as a pure orchestrator; this method just binds the context and delegates.
   */
  async closeHedge(params: {
    symbol: string;
    size?: number;
  }): Promise<BluefinHedgeResult> {
    await this.ensureInitializedAsync();
    return performCloseHedge(
      {
        walletAddress: this.walletAddress,
        network: this.network,
        apiRequest: this.apiRequest.bind(this),
        getPositions: this.getPositions.bind(this),
        getMarketData: this.getMarketData.bind(this),
        signOrder: this.signOrderFields.bind(this),
      },
      params,
    );
  }

  /** Get order book for a symbol. Delegates to bluefin/market-data.fetchOrderBook. */
  async getOrderBook(symbol: string, depth: number = 10): Promise<{
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
  }> {
    await this.ensureInitializedAsync();
    return fetchOrderBook(this.exchangeApi, symbol, depth);
  }

  /** Get funding rate history. Delegates to bluefin/market-data.fetchFundingRates. */
  async getFundingRates(symbol: string): Promise<Array<{ time: number; rate: number }>> {
    await this.ensureInitializedAsync();
    return fetchFundingRates(this.exchangeApi, symbol);
  }

  /**
   * Convert asset symbol to BlueFin pair symbol
   */
  static assetToPair(asset: string): string | null {
    const mapping: Record<string, string> = {
      BTC: 'BTC-PERP',
      ETH: 'ETH-PERP',
      SUI: 'SUI-PERP',
      SOL: 'SOL-PERP',
      GOLD: 'GOLD-PERP',
      HYPE: 'HYPE-PERP',
      DEEP: 'DEEP-PERP',
      WAL: 'WAL-PERP',
    };
    return mapping[asset.toUpperCase()] || null;
  }

  /**
   * Ensure client is initialized - auto-initializes from env vars if not already initialized
   */
  private async ensureInitializedAsync(): Promise<void> {
    if (!this.initialized) {
      const privateKey = (process.env.BLUEFIN_PRIVATE_KEY || '').trim();
      const network = (
        process.env.BLUEFIN_NETWORK ||
        process.env.SUI_NETWORK ||
        'mainnet'
      ).trim() as 'mainnet' | 'testnet';

      if (!privateKey) {
        throw new Error(
          'BlueFin client not initialized. Set BLUEFIN_PRIVATE_KEY or call initialize() first.'
        );
      }

      await this.initialize(privateKey, network);
    }
  }
}

// Export singleton instance
export const bluefinService = BluefinService.getInstance();
