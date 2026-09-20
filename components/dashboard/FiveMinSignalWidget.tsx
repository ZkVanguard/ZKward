'use client';

import { useState, useEffect, useCallback, useRef, memo, useMemo } from 'react';
import {
  TrendingUp, TrendingDown, Clock, Zap, Activity,
  AlertTriangle, ChevronDown, ChevronUp, Shield
} from 'lucide-react';
import type { FiveMinBTCSignal, FiveMinSignalHistory } from '@/lib/services/market-data/Polymarket5MinService';

// ─── Constants ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 15_000;
const COUNTDOWN_INTERVAL_MS = 1_000;
const CONFIDENCE_BARS = [1, 2, 3, 4, 5] as const;

// ─── Cached module reference ─────────────────────────────────────────
// Avoids re-resolving the dynamic import on every poll cycle.
let serviceModulePromise: Promise<typeof import('@/lib/services/market-data/Polymarket5MinService')> | null = null;
function getService() {
  if (!serviceModulePromise) {
    serviceModulePromise = import('@/lib/services/market-data/Polymarket5MinService');
  }
  return serviceModulePromise;
}

// ─── Memoized sub-components ─────────────────────────────────────────

/** Static confidence bar. Only re-renders when level or color changes */
const ConfidenceMeter = memo(function ConfidenceMeter({
  level, isUp,
}: { level: number; isUp: boolean }) {
  const filledClass = isUp ? 'bg-emerald-500' : 'bg-red-500';
  return (
    <div className="text-right">
      <div className="text-xs text-gray-500 mb-1">Confidence</div>
      <div className="flex gap-0.5">
        {CONFIDENCE_BARS.map(i => (
          <div
            key={i}
            className={`w-2 h-4 rounded-sm ${i <= level ? filledClass : 'bg-gray-200'}`}
          />
        ))}
      </div>
    </div>
  );
});

/** Probability bar. Amplified visual so 49-51% shifts are clearly visible.
 *  The bar "zooms" the 40-60% range to fill the full width,
 *  so a real 51% vs 49% renders as 55% vs 45% visually.
 *  Delta arrows show change since previous fetch. */
const ProbabilityBar = memo(function ProbabilityBar({
  displayUp, displayDown, deltaUp,
}: { displayUp: number; displayDown: number; deltaUp: number | null }) {
  // Amplify: map 40-60% → 0-100% so small shifts fill the bar
  const amplified = Math.min(100, Math.max(0, ((displayUp - 40) / 20) * 100));
  const ampDown = 100 - amplified;
  const deltaStr = deltaUp !== null && Math.abs(deltaUp) >= 0.01
    ? (deltaUp > 0 ? `▲+${deltaUp.toFixed(2)}` : `▼${deltaUp.toFixed(2)}`)
    : null;
  const deltaColor = deltaUp !== null && deltaUp > 0 ? 'text-emerald-500' : 'text-red-400';

  return (
    <>
      <div className="mt-3 relative h-2.5 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="absolute left-0 top-0 h-full bg-emerald-500 rounded-full transition-all duration-700"
          style={{ width: `${amplified}%` }}
        />
        <div
          className="absolute right-0 top-0 h-full bg-red-500 rounded-full transition-all duration-700"
          style={{ width: `${ampDown}%` }}
        />
        {/* Center tick mark at 50/50 */}
        <div className="absolute left-1/2 top-0 w-px h-full bg-gray-300/60" />
      </div>
      <div className="flex justify-between mt-1 text-[10px] text-gray-400">
        <span className="flex items-center gap-1">
          UP {displayUp.toFixed(2)}%
          {deltaStr && <span className={`font-semibold ${deltaColor}`}>{deltaStr}</span>}
        </span>
        <span>DOWN {displayDown.toFixed(2)}%</span>
      </div>
    </>
  );
});

/** Expandable details panel. Conditionally rendered, isolated rendering */
const SignalDetails = memo(function SignalDetails({
  signal, history, isUp, onQuickHedge: _onQuickHedge,
}: {
  signal: FiveMinBTCSignal;
  history: FiveMinSignalHistory | null;
  isUp: boolean;
  onQuickHedge?: (dir: 'LONG' | 'SHORT') => void;
}) {
  const volumeDisplay = useMemo(
    () => signal.volume >= 0 ? `$${signal.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'N/A',
    [signal.volume],
  );
  const liquidityDisplay = useMemo(
    () => signal.liquidity > 0
      ? (signal.liquidity >= 1000 ? `$${(signal.liquidity / 1000).toFixed(1)}K` : `$${signal.liquidity.toFixed(0)}`)
      : null,
    [signal.liquidity],
  );
  const priceDisplay = useMemo(
    () => signal.priceToBeat ? `$${signal.priceToBeat.toLocaleString()}` : null,
    [signal.priceToBeat],
  );
  const recLabel = signal.recommendation === 'WAIT'
    ? '⏸ Wait'
    : signal.recommendation === 'HEDGE_SHORT' ? '🔴 Hedge Short' : '🟢 Hedge Long';

  // Pre-slice history for mini-viz (avoid slicing on every render frame)
  const historyBars = useMemo(
    () => history?.signals.slice(-20) ?? [],
    [history?.signals],
  );

  return (
    <div className="px-4 pb-4 space-y-3 border-t border-gray-100 pt-3">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-gray-50 rounded-lg p-2">
          <div className="text-gray-400 mb-0.5">Volume</div>
          <div className="font-semibold text-gray-700">{volumeDisplay}</div>
        </div>
        <div className="bg-gray-50 rounded-lg p-2">
          <div className="text-gray-400 mb-0.5">Liquidity</div>
          <div className="font-semibold text-gray-700">{liquidityDisplay ?? 'N/A'}</div>
        </div>
        <div className="bg-gray-50 rounded-lg p-2 col-span-2">
          <div className="text-gray-400 mb-0.5">Recommendation</div>
          <div className="font-semibold text-gray-700">{recLabel}</div>
        </div>
        {priceDisplay && (
          <div className="bg-gray-50 rounded-lg p-2 col-span-2">
            <div className="text-gray-400 mb-0.5">Price to Beat</div>
            <div className="font-semibold text-gray-700">{priceDisplay}</div>
          </div>
        )}
      </div>

      {history && (
        <div className="bg-gray-50 rounded-lg p-2">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Activity className="w-3 h-3 text-gray-400" />
            <span className="text-xs font-medium text-gray-600">Signal History (30 min)</span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-[11px] sm:text-xs min-w-0">
            <div className="min-w-0">
              <div className="text-gray-400 truncate">Streak</div>
              <div className={`font-semibold truncate tabular-nums ${history.streak.direction === 'UP' ? 'text-emerald-600' : 'text-red-500'}`}>
                {history.streak.count}x {history.streak.direction}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-gray-400 truncate">Avg Conf.</div>
              <div className="font-semibold text-gray-700 tabular-nums truncate">{history.avgConfidence}%</div>
            </div>
            <div className="min-w-0">
              <div className="text-gray-400 truncate">Signals</div>
              <div className="font-semibold text-gray-700 tabular-nums truncate">{history.signals.length}</div>
            </div>
          </div>
          {historyBars.length > 0 && (
            <div className="flex gap-0.5 mt-2">
              {historyBars.map((s, i) => (
                <div
                  key={i}
                  className={`flex-1 h-3 rounded-sm ${s.direction === 'UP' ? 'bg-emerald-400' : 'bg-red-400'}`}
                  title={`${s.direction} ${s.probability.toFixed(0)}%`}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {signal.signalStrength === 'STRONG' && (
        <div className={`flex items-start gap-2 text-[10px] ${isUp ? 'text-emerald-600' : 'text-red-500'} bg-gray-50 rounded-lg p-2`}>
          <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
          <span>
            Strong {signal.direction} signal detected. Agents have auto-weighted this signal
            3x in risk/hedge calculations.
          </span>
        </div>
      )}
    </div>
  );
});

// ─── Helpers ─────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function normalizeProbs(up: number, down: number): [number, number] {
  const sum = up + down;
  if (sum === 0) return [50, 50];
  // Keep 2-decimal precision so micro-shifts are visible (e.g. 50.53 vs 49.47)
  const nUp = Math.round((up / sum) * 10000) / 100;
  const nDown = Math.round((100 - nUp) * 100) / 100;
  return [nUp, nDown];
}

// ─── Main widget ─────────────────────────────────────────────────────

interface FiveMinSignalWidgetProps {
  onQuickHedge?: (direction: 'LONG' | 'SHORT') => void;
}

function FiveMinSignalWidgetInner({ onQuickHedge }: FiveMinSignalWidgetProps) {
  const [signal, setSignal] = useState<FiveMinBTCSignal | null>(null);
  const [history, setHistory] = useState<FiveMinSignalHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(0);
  const [deltaUp, setDeltaUp] = useState<number | null>(null);

  // Refs for stable interval control & request dedup
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const windowEndRef = useRef(0);
  const lastMarketIdRef = useRef('');
  const fetchingRef = useRef(false);    // dedup guard
  const mountedRef = useRef(true);      // unmount guard

  const fetchSignal = useCallback(async () => {
    // Guard: skip if another fetch is in-flight (dedup at widget level)
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    // Clear error at start of fetch so stale errors don't persist
    setError(null);
    try {
      const mod = await getService();
      const [latestSignal, signalHistory] = await Promise.all([
        mod.Polymarket5MinService.getLatest5MinSignal(),
        mod.Polymarket5MinService.getSignalHistory(),
      ]);

      // Bail if unmounted during async gap
      if (!mountedRef.current) return;

      if (latestSignal) {
        // Compute delta (change since last fetch) for the probability bar
        setSignal(prev => {
          if (prev) {
            setDeltaUp(latestSignal.upProbability - prev.upProbability);
          }
          return latestSignal;
        });
        setLastUpdated(Date.now());
        if (latestSignal.marketId !== lastMarketIdRef.current) {
          windowEndRef.current = latestSignal.windowEndTime
            || (Date.now() + latestSignal.timeRemainingSeconds * 1000);
          lastMarketIdRef.current = latestSignal.marketId;
          setDeltaUp(null); // reset delta on new window
        }
        setError(null);
      } else {
        setError('No active 5-min market');
      }
      if (signalHistory) setHistory(signalHistory);
    } catch {
      if (mountedRef.current) setError('Signal unavailable');
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, []);

  // ── Lifecycle: poll + countdown (visibility-aware) ──────
  useEffect(() => {
    mountedRef.current = true;
    fetchSignal();

    const startTimers = () => {
      if (!intervalRef.current) intervalRef.current = setInterval(fetchSignal, POLL_INTERVAL_MS);
      if (!countdownRef.current) countdownRef.current = setInterval(() => {
        if (!mountedRef.current) return;
        if (windowEndRef.current > 0) {
          const remaining = Math.max(0, Math.floor((windowEndRef.current - Date.now()) / 1000));
          setCountdown(remaining);
          if (remaining === 0 && lastMarketIdRef.current) fetchSignal();
        }
      }, COUNTDOWN_INTERVAL_MS);
    };
    const stopTimers = () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    };
    const onVis = () => document.hidden ? stopTimers() : startTimers();
    document.addEventListener('visibilitychange', onVis);
    if (!document.hidden) startTimers();

    return () => {
      mountedRef.current = false;
      stopTimers();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchSignal]);

  // ── Memoised derived values ─────────────────────────────
  const [displayUp, displayDown] = useMemo(
    () => signal ? normalizeProbs(signal.upProbability, signal.downProbability) : [50, 50],
    [signal?.upProbability, signal?.downProbability],
  );

  const confidenceLevel = useMemo(
    () => signal ? Math.ceil(signal.confidence / 20) : 0,
    [signal?.confidence],
  );

  const isUp = signal?.direction === 'UP';
  const isStrong = signal?.signalStrength === 'STRONG';

  const containerBorder = useMemo(() => {
    if (!isStrong) return 'border-gray-200/60';
    return isUp ? 'border-emerald-300 shadow-emerald-100' : 'border-red-300 shadow-red-100';
  }, [isStrong, isUp]);

  const dirColor = isUp ? 'text-emerald-600' : 'text-red-500';
  const dirBg = isUp ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200';
  const strengthBadge = isStrong
    ? 'bg-amber-100 text-amber-700 border-amber-300'
    : signal?.signalStrength === 'MODERATE'
      ? 'bg-blue-100 text-blue-700 border-blue-300'
      : 'bg-gray-100 text-gray-500 border-gray-300';

  const updatedAgo = lastUpdated > 0 ? Math.floor((Date.now() - lastUpdated) / 1000) : 0;

  // ── Render: loading skeleton ───────────────────────────
  if (loading) {
    return (
      <div className="bg-white/80 backdrop-blur-xl rounded-[20px] border border-gray-200/60 p-4 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-1/3 mb-3" />
        <div className="h-8 bg-gray-200 rounded w-2/3 mb-2" />
        <div className="h-3 bg-gray-200 rounded w-1/2" />
      </div>
    );
  }

  // ── Render: error / empty ──────────────────────────────
  if (error || !signal) {
    return (
      <div className="bg-white/80 backdrop-blur-xl rounded-[20px] border border-gray-200/60 p-4">
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <Activity className="w-4 h-4" />
          <span>5-Min BTC Signal</span>
          <span className="ml-auto text-xs text-gray-400">{error || 'Waiting...'}</span>
        </div>
      </div>
    );
  }

  // ── Render: main widget ────────────────────────────────
  return (
    <div className={`bg-white/90 backdrop-blur-xl rounded-[20px] border ${containerBorder} shadow-sm transition-all duration-300`}>
      {/* Header */}
      <div className="p-3 sm:p-4 pb-2">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
            <Zap className="w-4 h-4 text-amber-500 flex-shrink-0" />
            <span className="text-[11px] sm:text-xs font-semibold text-gray-700 uppercase tracking-wide truncate">
              5-Min BTC Signal
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium flex-shrink-0 ${strengthBadge}`}>
              {signal.signalStrength}
            </span>
          </div>
          <div className="flex items-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs text-gray-500 flex-shrink-0 tabular-nums">
            {updatedAgo > 0 && (
              <span className="text-[9px] text-gray-400 mr-0.5 sm:mr-1 hidden sm:inline">{updatedAgo}s ago</span>
            )}
            <Clock className="w-3 h-3 flex-shrink-0" />
            <span className={countdown < 60 ? 'text-red-500 font-semibold animate-pulse' : ''}>
              {formatTime(countdown)}
            </span>
          </div>
        </div>

        {/* Main signal */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${dirBg}`}>
              {isUp ? (
                <TrendingUp className={`w-4 h-4 sm:w-5 sm:h-5 ${dirColor}`} />
              ) : (
                <TrendingDown className={`w-4 h-4 sm:w-5 sm:h-5 ${dirColor}`} />
              )}
            </div>
            <div className="min-w-0">
              <div className={`text-base sm:text-lg font-bold ${dirColor} tabular-nums`}>
                BTC {signal.direction}
              </div>
              <div className="text-[11px] sm:text-xs text-gray-500 tabular-nums">
                {signal.probability.toFixed(2)}% probability
              </div>
            </div>
          </div>

          <ConfidenceMeter level={confidenceLevel} isUp={isUp} />
        </div>

        <ProbabilityBar displayUp={displayUp} displayDown={displayDown} deltaUp={deltaUp} />
      </div>

      {/* Quick Hedge Action — iOS-compliant 44px tap target on mobile */}
      {isStrong && onQuickHedge && (
        <div className="px-3 sm:px-4 pb-2">
          <button
            onClick={() => onQuickHedge(isUp ? 'LONG' : 'SHORT')}
            className={`w-full h-11 sm:h-auto sm:py-2 rounded-xl text-xs sm:text-xs font-semibold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-all ${
              isUp
                ? 'bg-emerald-500 hover:bg-emerald-600 text-white'
                : 'bg-red-500 hover:bg-red-600 text-white'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            Quick {isUp ? 'Long' : 'Short'} Hedge
          </button>
        </div>
      )}

      {/* Expandable toggle. Enlarged tap area on mobile */}
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="w-full h-11 sm:h-auto px-4 py-2 flex items-center justify-center text-[11px] sm:text-xs text-gray-400 hover:text-gray-600 active:bg-gray-50 transition-colors border-t border-gray-100"
      >
        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        <span className="ml-1">{expanded ? 'Less' : 'Details'}</span>
      </button>

      {/* Expanded details (memoised sub-component) */}
      {expanded && (
        <SignalDetails
          signal={signal}
          history={history}
          isUp={isUp}
          onQuickHedge={onQuickHedge}
        />
      )}
    </div>
  );
}

export const FiveMinSignalWidget = memo(FiveMinSignalWidgetInner);
