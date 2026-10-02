/**
 * Polymarket 5-Minute BTC Signal Service (High-Performance + Proactive Ticker)
 *
 * Fetches real-time "Bitcoin Up or Down" 5-minute binary markets from Polymarket.
 * Markets resolve via Chainlink BTC/USD data stream.
 *
 * Performance optimizations:
 *   - Tiered slug discovery: hot 4 windows → extended 10 only on miss
 *   - BTC price cached independently (30 s TTL) to avoid redundant fetches
 *   - In-flight deduplication: concurrent callers share a single network cycle
 *   - Pre-compiled regex for window-label extraction
 *   - Signal history managed as a bounded ring buffer (no slice/filter per call)
 *   - Cached history snapshot invalidated only when buffer mutates
 *
 * Proactive Ticker:
 *   - Background 10 s polling loop pushes updates to all subscribed agents
 *   - Emits typed events: signal:update, signal:direction-flip, signal:new-window, signal:strong-alert
 *   - Agents never poll individually — they subscribe once and always have fresh data
 *   - Automatically aligns to 5-min window boundaries for zero-delay transitions
 *
 * Signal Flow:
 *   Polymarket 5-min market → parse UP/DOWN probabilities → generate signal
 *   → ticker broadcasts → RiskAgent, HedgingAgent, PriceMonitorAgent react instantly
 */

import { EventEmitter } from 'events';
import { logger } from '@/lib/utils/logger';
import type { FiveMinBTCSignal, FiveMinSignalHistory } from '@/lib/types/market-signals';

export type { FiveMinBTCSignal, FiveMinSignalHistory };
import { cache } from '../../utils/cache';

// ─── Types ───────────────────────────────────────────────────────────



// ─── Constants ───────────────────────────────────────────────────────

const WINDOW_SECONDS = 300;
const CACHE_TTL_MS = 15_000;
const BTC_PRICE_TTL_MS = 30_000;
const HISTORY_MAX = 50;
const HISTORY_WINDOW_MS = 30 * 60 * 1000;
const SLUG_TIMEOUT_MS = 5_000;
const BTC_TIMEOUT_MS = 3_000;
const TICKER_INTERVAL_MS = 10_000;    // Proactive background poll
const WINDOW_BOUNDARY_LEAD_MS = 2_000; // Pre-fetch 2 s before window boundary

// ─── Ticker Event Types ──────────────────────────────────────────────

export type SignalEventType =
  | 'signal:update'          // Every tick — latest signal (may be cached)
  | 'signal:direction-flip'  // Direction changed from previous signal
  | 'signal:new-window'      // New 5-min market window started
  | 'signal:strong-alert';   // STRONG signal detected — agents should act NOW

export interface SignalEvent {
  type: SignalEventType;
  signal: FiveMinBTCSignal;
  previous: FiveMinBTCSignal | null;
  history: FiveMinSignalHistory;
  timestamp: number;
}

/** Pre-compiled regex — avoids re-compilation on every parse */
const TIME_WINDOW_RE = /(\d{1,2}(?::\d{2})?(?:AM|PM)?)\s*[-–]\s*(\d{1,2}:\d{2}(?:AM|PM))\s*(ET|EST|UTC)?/i;

/** Hot offsets checked first (covers current + immediate vicinity) */
const HOT_OFFSETS = [-300, 0, 300, 600] as const;
/** Extended offsets used only when hot scan misses */
const EXTENDED_OFFSETS = [900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600] as const;

// ─── Service ─────────────────────────────────────────────────────────

export class Polymarket5MinService {
  private static readonly POLYMARKET_API = 'https://gamma-api.polymarket.com';
  private static readonly CACHE_TTL_MS = CACHE_TTL_MS;
  private static readonly SIGNAL_HISTORY_KEY = 'polymarket-5min-history';

  // ── Ring-buffer history ───────────────────────────────
  private static signalHistory: FiveMinBTCSignal[] = [];
  private static historyVersion = 0;           // bumped on mutation
  private static cachedHistoryVersion = -1;     // version of last snapshot
  private static cachedHistorySnapshot: FiveMinSignalHistory | null = null;

  // ── In-flight deduplication ───────────────────────────
  private static inflight: Promise<FiveMinBTCSignal | null> | null = null;

  // ── Cached BTC price ──────────────────────────────────
  private static btcPriceCache: { price: number; ts: number } = { price: 0, ts: 0 };

  // ── Proactive Ticker ──────────────────────────────────
  private static emitter = new EventEmitter();
  private static tickerInterval: ReturnType<typeof setInterval> | null = null;
  private static boundaryTimeout: ReturnType<typeof setTimeout> | null = null;
  private static tickerRunning = false;
  private static lastTickSignal: FiveMinBTCSignal | null = null;

  /**
   * Subscribe to real-time signal events.
   * @param event Event type (or '*' is not supported — use specific types)
   * @param listener Callback invoked with SignalEvent
   * @returns Unsubscribe function for cleanup
   *
   * @example
   *   const unsub = Polymarket5MinService.on('signal:update', (evt) => {
   *     console.log(evt.signal.direction, evt.signal.probability);
   *   });
   *   // later: unsub();
   */
  static on(event: SignalEventType, listener: (evt: SignalEvent) => void): () => void {
    this.emitter.on(event, listener);
    // Auto-start ticker on first subscriber
    if (!this.tickerRunning) this.startTicker();
    return () => { this.off(event, listener); };
  }

  /** Remove a specific listener. Auto-stops ticker when last subscriber leaves. */
  static off(event: SignalEventType, listener: (evt: SignalEvent) => void): void {
    this.emitter.removeListener(event, listener);
    // Auto-stop ticker when no subscribers remain
    if (this.tickerRunning && this.subscriberCount() === 0) {
      logger.info('Last subscriber removed — auto-stopping ticker');
      this.stopTicker();
    }
  }

  /**
   * Start the proactive background ticker.
   * Polls every 10 s and emits typed events. Also schedules a boundary-aligned
   * fetch 2 s before the current 5-min window ends so agents react instantly
   * when a new window opens.
   */
  static startTicker(): void {
    if (this.tickerRunning) return;
    this.tickerRunning = true;
    logger.info('Polymarket 5-min signal ticker started', { intervalMs: TICKER_INTERVAL_MS });

    // Fire immediately, then every 10 s
    this.tickOnce();
    this.tickerInterval = setInterval(() => this.tickOnce(), TICKER_INTERVAL_MS);
    this.scheduleWindowBoundary();
  }

  /** Stop the background ticker and release resources */
  static stopTicker(): void {
    if (!this.tickerRunning) return;
    this.tickerRunning = false;
    if (this.tickerInterval) { clearInterval(this.tickerInterval); this.tickerInterval = null; }
    if (this.boundaryTimeout) { clearTimeout(this.boundaryTimeout); this.boundaryTimeout = null; }
    logger.info('Polymarket 5-min signal ticker stopped');
  }

  /** Whether the background ticker is currently running */
  static isTickerRunning(): boolean { return this.tickerRunning; }

  /** How many listeners are subscribed across all event types */
  static subscriberCount(): number {
    return (['signal:update', 'signal:direction-flip', 'signal:new-window', 'signal:strong-alert'] as const)
      .reduce((n, ev) => n + this.emitter.listenerCount(ev), 0);
  }

  /**
   * Single tick — fetch latest signal, diff against previous, emit events.
   * Called by the interval and by the boundary scheduler.
   */
  private static async tickOnce(): Promise<void> {
    try {
      const signal = await this.getLatest5MinSignal();
      if (!signal) return;

      const prev = this.lastTickSignal;
      const history = this.getSignalHistory();
      const base: Omit<SignalEvent, 'type'> = { signal, previous: prev, history, timestamp: Date.now() };

      // Always emit update
      this.emitter.emit('signal:update', { ...base, type: 'signal:update' } as SignalEvent);

      // Direction flip
      if (prev && prev.direction !== signal.direction) {
        logger.info('5-min signal direction FLIPPED', {
          from: prev.direction, to: signal.direction,
          probability: signal.probability,
        });
        this.emitter.emit('signal:direction-flip', { ...base, type: 'signal:direction-flip' } as SignalEvent);
      }

      // New window (different marketId)
      if (prev && prev.marketId !== signal.marketId) {
        logger.info('New 5-min market window opened', {
          oldMarketId: prev.marketId, newMarketId: signal.marketId,
          windowLabel: signal.windowLabel,
        });
        this.emitter.emit('signal:new-window', { ...base, type: 'signal:new-window' } as SignalEvent);
        // Re-schedule boundary for the new window
        this.scheduleWindowBoundary();
      }

      // Strong alert
      if (signal.signalStrength === 'STRONG') {
        this.emitter.emit('signal:strong-alert', { ...base, type: 'signal:strong-alert' } as SignalEvent);
      }

      this.lastTickSignal = signal;
    } catch (err) {
      logger.warn('Ticker tick failed', { error: err });
    }
  }

  /**
   * Schedule a high-priority fetch 2 s before the current 5-min window ends.
   * This ensures agents have the new-window signal ≤2 s after it opens.
   */
  private static scheduleWindowBoundary(): void {
    if (this.boundaryTimeout) { clearTimeout(this.boundaryTimeout); this.boundaryTimeout = null; }
    const sig = this.lastTickSignal;
    if (!sig || !sig.windowEndTime) return;

    const msUntilBoundary = sig.windowEndTime - Date.now() - WINDOW_BOUNDARY_LEAD_MS;
    if (msUntilBoundary <= 0) return; // Already past boundary

    this.boundaryTimeout = setTimeout(async () => {
      logger.info('Window boundary approaching — pre-fetching next signal');
      // Invalidate cache so next fetch is guaranteed fresh
      cache.invalidate('polymarket-5min-btc-latest');
      await this.tickOnce();
    }, msUntilBoundary);
  }

  /**
   * Get the latest 5-minute BTC UP/DOWN signal from Polymarket.
   * Concurrent callers share a single in-flight request (dedup).
   */
  static async getLatest5MinSignal(): Promise<FiveMinBTCSignal | null> {
    const cacheKey = 'polymarket-5min-btc-latest';
    const cached = cache.get<FiveMinBTCSignal>(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      return cached;
    }

    // Deduplicate — if a fetch is already in progress, piggyback on it
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchLatest5MinMarket()
      .then(signal => {
        if (signal) {
          cache.set(cacheKey, signal);
          this.addToHistory(signal);
        }
        return signal;
      })
      .catch(error => {
        logger.error('Failed to fetch 5-min BTC signal', error, { component: 'Polymarket5Min' });
        return cached || null;
      })
      .finally(() => { this.inflight = null; });

    return this.inflight;
  }

  /**
   * Get signal history (last 30 minutes of 5-min signals).
   * Returns a cached snapshot that only re-computes when the buffer mutates.
   */
  static getSignalHistory(): FiveMinSignalHistory {
    if (this.cachedHistorySnapshot && this.cachedHistoryVersion === this.historyVersion) {
      return this.cachedHistorySnapshot;
    }

    const now = Date.now();
    const recentSignals = this.signalHistory.filter(
      s => (now - s.fetchedAt) < HISTORY_WINDOW_MS
    );

    // Calculate streak (early-exit loop)
    let streakDir: 'UP' | 'DOWN' | 'MIXED' = recentSignals[0]?.direction || 'MIXED';
    let streakCount = 0;
    for (let i = 0, len = recentSignals.length; i < len; i++) {
      if (recentSignals[i].direction === streakDir) streakCount++;
      else break;
    }
    if (streakCount === 0) streakDir = 'MIXED';

    // Avg confidence — single pass
    let confSum = 0;
    for (let i = 0, len = recentSignals.length; i < len; i++) {
      confSum += recentSignals[i].confidence;
    }

    const snapshot: FiveMinSignalHistory = {
      signals: recentSignals,
      accuracy: this.calculateAccuracy(recentSignals),
      streak: { direction: streakDir, count: streakCount },
      avgConfidence: recentSignals.length > 0
        ? Math.round(confSum / recentSignals.length)
        : 0,
    };
    this.cachedHistorySnapshot = snapshot;
    this.cachedHistoryVersion = this.historyVersion;
    return snapshot;
  }

  /**
   * Build slug for a 5-min BTC market from an epoch timestamp.
   * Polymarket uses: btc-updown-5m-{epoch} where epoch is the start of the 5-min window.
   */
  private static buildSlug(epochSeconds: number): string {
    return `btc-updown-5m-${epochSeconds}`;
  }

  /**
   * Check whether a market has useful (non-resolved) outcome prices.
   * Resolved markets have exactly ["1", "0"] or ["0", "1"].
   */
  private static isResolved(market: Record<string, unknown>): boolean {
    try {
      const raw = market.outcomePrices as string;
      if (!raw) return false;
      const prices = JSON.parse(raw) as string[];
      if (!Array.isArray(prices) || prices.length < 2) return false;
      const p0 = parseFloat(prices[0]);
      const p1 = parseFloat(prices[1]);
      return (p0 === 1 && p1 === 0) || (p0 === 0 && p1 === 1);
    } catch {
      return false;
    }
  }

  // ── Slug fetch helper (reused across tiers) ───────────
  private static async fetchSlug(
    baseUrl: string,
    slug: string,
    controller: AbortController,
  ): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${baseUrl}?slug=${slug}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      const markets = Array.isArray(data) ? data : [data];
      return (markets.find((m: Record<string, unknown>) => m && m.slug === slug) as Record<string, unknown>) || null;
    } catch {
      return null;
    }
  }

  /**
   * Pick the best unresolved, future-ending market from a results array.
   */
  private static pickBest(
    results: (Record<string, unknown> | null)[],
  ): { market: Record<string, unknown>; endMs: number } | null {
    let bestMarket: Record<string, unknown> | null = null;
    let bestEnd = Infinity;
    const now = Date.now();
    for (let i = 0, len = results.length; i < len; i++) {
      const m = results[i];
      if (!m) continue;
      const endStr = m.endDate as string;
      if (!endStr) continue;
      const endMs = new Date(endStr).getTime();
      if (endMs <= now) continue;
      if (this.isResolved(m)) continue;
      if (endMs < bestEnd) { bestEnd = endMs; bestMarket = m; }
    }
    return bestMarket ? { market: bestMarket, endMs: bestEnd } : null;
  }

  /**
   * Fetch the latest active 5-min BTC market from Polymarket.
   *
   * Tiered discovery:
   *   1. Hot tier (4 slugs: -1, 0, +1, +2 windows) — covers 99 % of cases.
   *   2. Extended tier (10 more slugs up to +1 h) — only if hot tier misses.
   *   3. BTC price fetch runs in parallel with tier-1 to hide latency.
   */
  private static async fetchLatest5MinMarket(): Promise<FiveMinBTCSignal | null> {
    const baseUrl = typeof window !== 'undefined'
      ? '/api/polymarket'
      : `${this.POLYMARKET_API}/markets`;

    const nowEpoch = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowEpoch / WINDOW_SECONDS) * WINDOW_SECONDS;

    // Shared abort controller — cancelled if component unmounts or times out
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SLUG_TIMEOUT_MS);

    try {
      // ── Tier 1: hot windows + BTC price in parallel ──────
      const hotSlugs = HOT_OFFSETS.map(off => this.buildSlug(windowStart + off));
      const [hotResults, btcPrice] = await Promise.all([
        Promise.all(hotSlugs.map(slug => this.fetchSlug(baseUrl, slug, controller))),
        this.fetchBTCPrice(),
      ]);

      let best = this.pickBest(hotResults);

      // ── Tier 2: extended scan only on miss ────────────────
      if (!best) {
        const extSlugs = EXTENDED_OFFSETS.map(off => this.buildSlug(windowStart + off));
        const extResults = await Promise.all(
          extSlugs.map(slug => this.fetchSlug(baseUrl, slug, controller)),
        );
        best = this.pickBest(extResults);
      }

      if (!best) {
        logger.warn('No active 5-min BTC markets found via slug lookup', { component: 'Polymarket5Min' });
        return null;
      }

      return this.parseMarketToSignal(best.market, btcPrice);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Fetch BTC/USD price with its own 30 s cache to avoid redundant calls.
   * Uses server-side API route to avoid CORS issues.
   */
  private static async fetchBTCPrice(): Promise<number> {
    if (this.btcPriceCache.price > 0 && (Date.now() - this.btcPriceCache.ts) < BTC_PRICE_TTL_MS) {
      return this.btcPriceCache.price;
    }
    try {
      // Use server-side API route to avoid CORS blocking from crypto.com
      const res = await fetch(
        '/api/prices?symbol=BTC',
        { signal: AbortSignal.timeout(BTC_TIMEOUT_MS) },
      );
      if (res.ok) {
        const data = await res.json();
        // API returns { success, data: { price } } — unwrap correctly
        const rawPrice = data?.data?.price ?? data?.price ?? '0';
        const price = parseFloat(String(rawPrice)) || 0;
        if (price > 0) {
          this.btcPriceCache = { price, ts: Date.now() };
        }
        return price;
      }
    } catch { /* degrade gracefully */ }
    return this.btcPriceCache.price; // return stale if available
  }

  /**
   * Parse a Polymarket market object into our FiveMinBTCSignal format.
   */
  private static parseMarketToSignal(market: Record<string, unknown>, btcPrice: number = 0): FiveMinBTCSignal | null {
    try {
      const question = (market.question as string) || '';
      const marketId = (market.id as string) || (market.conditionId as string) || '';
      const slug = (market.slug as string) || '';
      const volume = parseFloat((market.volume as string) || (market.volumeNum as string) || '0');
      const liquidity = parseFloat((market.liquidity as string) || (market.liquidityNum as string) || '0');

      // Parse outcome prices: ["0.5053", "0.4947"] → Up=50.53%, Down=49.47%
      // Keep 2-decimal precision so even tiny market shifts are visible
      let upProb = 50;
      let downProb = 50;
      try {
        const pricesStr = market.outcomePrices as string;
        if (pricesStr) {
          const prices = typeof pricesStr === 'string' ? JSON.parse(pricesStr) : pricesStr;
          if (Array.isArray(prices) && prices.length >= 2) {
            upProb = Math.round(parseFloat(prices[0]) * 10000) / 100;   // e.g. 0.5053 → 50.53
            downProb = Math.round(parseFloat(prices[1]) * 10000) / 100; // e.g. 0.4947 → 49.47
          }
        }
      } catch {
        logger.warn('Failed to parse 5-min market outcome prices', { component: 'Polymarket5Min' });
      }

      const priceToBeat = btcPrice;

      // Extract time window label (uses pre-compiled regex)
      const timeMatch = question.match(TIME_WINDOW_RE);
      const windowLabel = timeMatch ? timeMatch[0] : (() => {
        const dashSplit = question.split(' - ');
        return dashSplit.length > 1 ? dashSplit[1].trim() : 'Current Window';
      })();

      // Calculate time remaining
      let timeRemainingSeconds = 300;
      let windowEndTime = Date.now() + 300_000;
      const endDateStr = market.endDate as string;
      if (endDateStr) {
        const endTime = new Date(endDateStr).getTime();
        windowEndTime = endTime;
        timeRemainingSeconds = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
      }

      // Direction + signal strength
      const direction: 'UP' | 'DOWN' = upProb >= downProb ? 'UP' : 'DOWN';
      const maxProb = Math.max(upProb, downProb);
      const probSkew = Math.abs(upProb - downProb);

      let signalStrength: 'STRONG' | 'MODERATE' | 'WEAK';
      if (probSkew >= 10 && volume >= 20) signalStrength = 'STRONG';
      else if (probSkew >= 4 || volume >= 50 || (liquidity >= 3000 && probSkew >= 2)) signalStrength = 'MODERATE';
      else signalStrength = 'WEAK';

      // Confidence: weighted combo of skew + volume + liquidity + time
      const volumeConfidence = Math.min(30, volume > 0 ? Math.log10(Math.max(volume, 1)) * 15 : 0);
      const liquidityConfidence = Math.min(15, liquidity > 0 ? Math.log10(Math.max(liquidity, 1)) * 4 : 0);
      const probConfidence = Math.min(50, probSkew * 4);
      const timeConfidence = timeRemainingSeconds > 60 ? 20 : Math.max(5, timeRemainingSeconds / 3);
      const confidence = Math.min(95, Math.round(volumeConfidence + liquidityConfidence + probConfidence + timeConfidence));

      // Recommendation
      let recommendation: 'HEDGE_SHORT' | 'HEDGE_LONG' | 'WAIT';
      if (signalStrength === 'STRONG') {
        recommendation = direction === 'DOWN' ? 'HEDGE_SHORT' : 'HEDGE_LONG';
      } else if (signalStrength === 'MODERATE' && maxProb >= 54) {
        recommendation = direction === 'DOWN' ? 'HEDGE_SHORT' : 'HEDGE_LONG';
      } else {
        recommendation = 'WAIT';
      }

      const signal: FiveMinBTCSignal = {
        marketId,
        windowLabel,
        direction,
        probability: maxProb,
        upProbability: upProb,
        downProbability: downProb,
        priceToBeat,
        currentPrice: btcPrice,
        volume,
        liquidity,
        confidence,
        recommendation,
        signalStrength,
        timeRemainingSeconds,
        windowEndTime,
        fetchedAt: Date.now(),
        question,
        sourceUrl: `https://polymarket.com/event/${slug || marketId}`,
      };

      logger.info('5-min BTC signal parsed', {
        component: 'Polymarket5Min',
        data: {
          direction: signal.direction,
          probability: signal.probability,
          confidence: signal.confidence,
          recommendation: signal.recommendation,
          volume: signal.volume,
          liquidity: signal.liquidity,
          timeRemaining: signal.timeRemainingSeconds,
          priceToBeat: signal.priceToBeat,
          windowLabel: signal.windowLabel,
          slug,
        },
      });

      return signal;
    } catch (error) {
      logger.error('Failed to parse 5-min market', error, { component: 'Polymarket5Min' });
      return null;
    }
  }

  /**
   * Add signal to history. Deduplicates by marketId (update-in-place).
   * Bumps historyVersion to invalidate cached snapshot.
   */
  private static addToHistory(signal: FiveMinBTCSignal): void {
    if (this.signalHistory.length > 0 && this.signalHistory[0].marketId === signal.marketId) {
      this.signalHistory[0] = signal;
    } else {
      this.signalHistory.unshift(signal);
      if (this.signalHistory.length > HISTORY_MAX) {
        this.signalHistory.length = HISTORY_MAX; // Truncate in-place (no alloc)
      }
    }
    this.historyVersion++;
  }

  /**
   * Calculate running accuracy of recent signals.
   *
   * For each RESOLVED signal (window ended), find the earliest snapshot
   * we observed AFTER `windowEndTime` and use its `currentPrice` as the
   * realized BTC price at resolution. Realized direction is then UP iff
   * `realizedPrice >= priceToBeat`. Accuracy = predicted matches realized.
   *
   * `signalHistory` is stored newest-first via `unshift`, so newer
   * snapshots live at LOWER indices. We walk i-1..0 to find the first
   * later observation. This is best-effort: signals only persist in-
   * memory (50 max); if no later snapshot exists, the signal is excluded
   * from the count.
   */
  private static calculateAccuracy(signals: FiveMinBTCSignal[]): { correct: number; total: number; rate: number } {
    let total = 0;
    let correct = 0;
    for (let i = 0; i < signals.length; i++) {
      const s = signals[i];
      if (s.timeRemainingSeconds > 0) continue;
      if (!Number.isFinite(s.priceToBeat) || s.priceToBeat <= 0) continue;
      // Newer snapshots are at indices LESS than i (history is unshifted).
      // Walk backwards from i-1 -> 0 and pick the first one whose fetchedAt
      // is strictly after windowEndTime — that's the closest realized obs.
      let realizedPrice: number | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const snap = signals[j];
        if (snap.fetchedAt > s.windowEndTime && snap.currentPrice > 0) {
          realizedPrice = snap.currentPrice;
          break;
        }
      }
      if (realizedPrice == null) continue;
      const realizedDirection: 'UP' | 'DOWN' =
        realizedPrice >= s.priceToBeat ? 'UP' : 'DOWN';
      total++;
      if (realizedDirection === s.direction) correct++;
    }
    return {
      correct,
      total,
      rate: total > 0 ? Math.round((correct / total) * 100) : 0,
    };
  }

  /**
   * Convert 5-min signal to a PredictionMarket format for agent consumption.
   */
  static signalToPredictionMarket(signal: FiveMinBTCSignal): import('./DelphiMarketService').PredictionMarket {
    const priceDisplay = signal.priceToBeat > 0
      ? `$${signal.priceToBeat.toLocaleString('en-US')}`
      : 'live';
    return {
      id: `polymarket-5min-${signal.marketId}`,
      question: `⚡ 5-Min BTC Signal: ${signal.direction} (${signal.windowLabel}) — BTC @ ${priceDisplay}`,
      category: 'price',
      probability: signal.probability,
      volume: signal.volume > 1000 ? `$${(signal.volume / 1000).toFixed(1)}K` : `$${signal.volume.toFixed(0)}` + (signal.liquidity > 0 ? ` (liq: $${signal.liquidity > 1000 ? (signal.liquidity / 1000).toFixed(1) + 'K' : signal.liquidity.toFixed(0)})` : ''),
      impact: signal.signalStrength === 'STRONG' ? 'HIGH' : signal.signalStrength === 'MODERATE' ? 'MODERATE' : 'LOW',
      relatedAssets: ['BTC'],
      lastUpdate: signal.fetchedAt,
      confidence: signal.confidence,
      recommendation: signal.recommendation === 'HEDGE_SHORT' ? 'HEDGE' : 'MONITOR',
      source: 'polymarket',
      aiSummary: `Polymarket 5-min binary: ${signal.upProbability}% UP / ${signal.downProbability}% DOWN. Volume: $${signal.volume.toFixed(0)}. Liquidity: $${signal.liquidity.toFixed(0)}. Signal: ${signal.signalStrength}. ${signal.recommendation === 'WAIT' ? 'No clear directional edge.' : `${signal.recommendation} recommended (${signal.confidence}% confidence).`}`,
    };
  }

  /**
   * Reset all internal state — used by tests to avoid cross-test leakage.
   * @internal
   */
  static resetForTesting(): void {
    this.signalHistory = [];
    this.historyVersion = 0;
    this.cachedHistoryVersion = -1;
    this.cachedHistorySnapshot = null;
    this.inflight = null;
    this.btcPriceCache = { price: 0, ts: 0 };
    this.lastTickSignal = null;
    this.stopTicker();
    this.emitter.removeAllListeners();
  }
}
