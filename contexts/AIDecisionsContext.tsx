'use client';

import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { usePositions } from './PositionsContext';
import { useWallet } from '@/lib/hooks/useWallet';
import { logger } from '@/lib/utils/logger';
import {
  AIDecisions,
  RiskAnalysis,
  HedgeRecommendation,
  InsightSummary,
  PortfolioAction,
  onAIEvent,
  fetchAllAIDecisions,
  invalidateAllCache,
  fetchCustomPortfolioAction,
  CustomActionPayload,
} from '@/lib/services/ai-decisions';
import { 
  AIPriceIntegration,
  onPriceUpdate,
} from '@/lib/services/ai-price-integration';
import { AIManager } from '@/lib/services/ai-manager';

export type { CustomActionPayload };

// ============================================================================
// Re-export types for convenience
// ============================================================================
export type { RiskAnalysis, HedgeRecommendation, InsightSummary, PortfolioAction };

// ============================================================================
// Context State Types
// ============================================================================

export interface AIDecisionsState {
  // Risk Analysis
  risk: RiskAnalysis | null;
  riskLoading: boolean;
  riskError: string | null;

  // Hedge Recommendations
  hedges: HedgeRecommendation[];
  hedgesLoading: boolean;
  hedgesError: string | null;

  // Market Insights
  insights: InsightSummary | null;
  insightsLoading: boolean;
  insightsError: string | null;

  // Portfolio Actions
  action: PortfolioAction | null;
  actionLoading: boolean;
  actionError: string | null;

  // Global state
  lastUpdated: number;
  isInitialized: boolean;
}

export interface AIDecisionsContextType {
  // State
  state: AIDecisionsState;
  
  // Individual fetchers
  refreshRisk: (force?: boolean) => Promise<void>;
  refreshHedges: (force?: boolean) => Promise<void>;
  refreshInsights: (predictions: Array<{ id: string; probability: number; [key: string]: unknown }>, force?: boolean) => Promise<void>;
  refreshAction: (force?: boolean) => Promise<void>;
  
  // Batch operations
  refreshAll: (options?: { force?: boolean; predictions?: Array<{ id: string; probability: number }> }) => Promise<void>;
  invalidateAll: () => void;
  
  // Cache status
  getCacheStatus: () => Record<string, { valid: boolean; age: number }>;
  
  // Computed helpers
  hasAnyLoading: boolean;
  hasAnyError: boolean;
  hasStaleData: boolean;
  
  // Quick access to best hedge recommendation
  topHedge: HedgeRecommendation | null;
  
  // Quick access to market sentiment
  marketSentiment: 'bullish' | 'bearish' | 'neutral';
  
  // Quick access to recommended action
  recommendedAction: PortfolioAction['action'] | null;
  
  // Custom action request for complex payloads (with predictions, realMetrics)
  requestCustomAction: (payload: CustomActionPayload, force?: boolean) => Promise<PortfolioAction | null>;
}

// ============================================================================
// Initial State
// ============================================================================

const initialState: AIDecisionsState = {
  risk: null,
  riskLoading: false,
  riskError: null,
  hedges: [],
  hedgesLoading: false,
  hedgesError: null,
  insights: null,
  insightsLoading: false,
  insightsError: null,
  action: null,
  actionLoading: false,
  actionError: null,
  lastUpdated: 0,
  isInitialized: false,
};

// ============================================================================
// Context
// ============================================================================

const AIDecisionsContext = createContext<AIDecisionsContextType | undefined>(undefined);

// Debounce helper
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = React.useState(value);
  
  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  
  return debouncedValue;
}

export function AIDecisionsProvider({ children }: { children: React.ReactNode }) {
  const { portfolioAddress: address } = useWallet();
  const { positionsData } = usePositions();
  
  // State
  const [state, setState] = useState<AIDecisionsState>(initialState);
  
  // Refs for tracking
  const lastAddressRef = useRef<string | null>(null);
  const lastPortfolioHashRef = useRef<string>('');
  const initializingRef = useRef<boolean>(false);
  
  // Compute portfolio hash for change detection
  const portfolioHash = useMemo(() => {
    if (!positionsData) return '';
    return `${positionsData.totalValue}-${positionsData.positions?.length || 0}`;
  }, [positionsData]);
  
  // OPTIMIZATION: Debounce portfolio changes to prevent cascading re-renders
  // Wait 500ms for positions to stabilize before triggering AI refresh
  const debouncedPortfolioHash = useDebouncedValue(portfolioHash, 500);
  
  // ============================================================================
  // Individual Refresh Functions
  // ============================================================================
  
  const refreshRisk = useCallback(async (force = false) => {
    if (!address) return;
    
    setState(prev => ({ ...prev, riskLoading: true, riskError: null }));
    
    try {
      const risk = await AIDecisions.fetchRisk(address, force);
      setState(prev => ({ 
        ...prev, 
        risk, 
        riskLoading: false,
        lastUpdated: Date.now(),
        isInitialized: true,
      }));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to fetch risk';
      setState(prev => ({ ...prev, riskLoading: false, riskError: errorMsg }));
    }
  }, [address]);
  
  const refreshHedges = useCallback(async (force = false) => {
    if (!address) return;
    
    setState(prev => ({ ...prev, hedgesLoading: true, hedgesError: null }));
    
    try {
      const hedges = await AIDecisions.fetchHedges(address, force);
      setState(prev => ({ 
        ...prev, 
        hedges, 
        hedgesLoading: false,
        lastUpdated: Date.now(),
        isInitialized: true,
      }));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to fetch hedges';
      setState(prev => ({ ...prev, hedgesLoading: false, hedgesError: errorMsg }));
    }
  }, [address]);
  
  const refreshInsights = useCallback(async (
    predictions: Array<{ id: string; probability: number; [key: string]: unknown }>,
    force = false
  ) => {
    if (predictions.length === 0) return;
    
    setState(prev => ({ ...prev, insightsLoading: true, insightsError: null }));
    
    try {
      const insights = await AIDecisions.fetchInsights(predictions, force);
      setState(prev => ({ 
        ...prev, 
        insights, 
        insightsLoading: false,
        lastUpdated: Date.now(),
        isInitialized: true,
      }));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to fetch insights';
      setState(prev => ({ ...prev, insightsLoading: false, insightsError: errorMsg }));
    }
  }, []);
  
  const requestCustomAction = useCallback(async (
    payload: CustomActionPayload,
    force = false
  ): Promise<PortfolioAction | null> => {
    setState(prev => ({ ...prev, actionLoading: true, actionError: null }));
    
    try {
      const action = await fetchCustomPortfolioAction(payload, force);
      setState(prev => ({ 
        ...prev, 
        action, 
        actionLoading: false,
        lastUpdated: Date.now(),
        isInitialized: true,
      }));
      return action;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to fetch action';
      setState(prev => ({ ...prev, actionLoading: false, actionError: errorMsg }));
      return null;
    }
  }, []);
  
  const refreshAction = useCallback(async (force = false) => {
    if (!address || !positionsData) return;
    
    setState(prev => ({ ...prev, actionLoading: true, actionError: null }));
    
    try {
      const action = await AIDecisions.fetchAction(address, {
        totalValue: positionsData.totalValue,
        positions: positionsData.positions,
      }, force);
      setState(prev => ({ 
        ...prev, 
        action, 
        actionLoading: false,
        lastUpdated: Date.now(),
        isInitialized: true,
      }));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to fetch action';
      setState(prev => ({ ...prev, actionLoading: false, actionError: errorMsg }));
    }
  }, [address, positionsData]);
  
  // ============================================================================
  // Batch Operations
  // ============================================================================
  
  const refreshAll = useCallback(async (options?: { 
    force?: boolean; 
    predictions?: Array<{ id: string; probability: number }> 
  }) => {
    if (!address) return;
    
    const { force = false, predictions = [] } = options || {};
    
    setState(prev => ({
      ...prev,
      riskLoading: true,
      hedgesLoading: true,
      insightsLoading: predictions.length > 0,
      actionLoading: !!positionsData,
      riskError: null,
      hedgesError: null,
      insightsError: null,
      actionError: null,
    }));
    
    try {
      const results = await fetchAllAIDecisions(address, {
        predictions,
        portfolioData: positionsData ? {
          totalValue: positionsData.totalValue,
          positions: positionsData.positions,
        } : undefined,
        force,
        skipInsights: predictions.length === 0,
        skipAction: !positionsData,
      });
      
      setState(prev => ({
        ...prev,
        risk: results.risk || prev.risk,
        hedges: results.hedges || prev.hedges,
        insights: results.insights || prev.insights,
        action: results.action || prev.action,
        riskLoading: false,
        hedgesLoading: false,
        insightsLoading: false,
        actionLoading: false,
        riskError: results.errors.find(e => e.startsWith('Risk')) || null,
        hedgesError: results.errors.find(e => e.startsWith('Hedges')) || null,
        insightsError: results.errors.find(e => e.startsWith('Insights')) || null,
        actionError: results.errors.find(e => e.startsWith('Action')) || null,
        lastUpdated: Date.now(),
        isInitialized: true,
      }));
      
      logger.info('[AIDecisionsContext] Refreshed all AI decisions', { 
        hasRisk: !!results.risk,
        hedgeCount: results.hedges?.length || 0,
        hasInsights: !!results.insights,
        hasAction: !!results.action,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to fetch AI decisions';
      logger.error('[AIDecisionsContext] Refresh all failed', err instanceof Error ? err : undefined);
      setState(prev => ({
        ...prev,
        riskLoading: false,
        hedgesLoading: false,
        insightsLoading: false,
        actionLoading: false,
        riskError: errorMsg,
        hedgesError: errorMsg,
        insightsError: errorMsg,
        actionError: errorMsg,
      }));
    }
  }, [address, positionsData]);
  
  const invalidateAll = useCallback(() => {
    invalidateAllCache();
    setState(prev => ({
      ...prev,
      lastUpdated: 0,
    }));
    logger.info('[AIDecisionsContext] Cache invalidated');
  }, []);
  
  const getCacheStatus = useCallback(() => {
    return AIDecisions.getCacheStatus();
  }, []);
  
  // ============================================================================
  // Auto-refresh on address/portfolio change
  // ============================================================================
  
  useEffect(() => {
    if (!address) {
      // Clear state when wallet disconnects
      setState(initialState);
      lastAddressRef.current = null;
      return;
    }
    
    // Check if we need to refresh (using debounced portfolio hash)
    const addressChanged = lastAddressRef.current !== address;
    const portfolioChanged = lastPortfolioHashRef.current !== debouncedPortfolioHash && lastPortfolioHashRef.current !== '';
    
    if (addressChanged || portfolioChanged) {
      logger.debug('[AIDecisionsContext] Triggering refresh', { 
        addressChanged, 
        portfolioChanged 
      });
      
      lastAddressRef.current = address;
      lastPortfolioHashRef.current = debouncedPortfolioHash;
      
      // Only auto-refresh if not already initializing
      if (!initializingRef.current) {
        initializingRef.current = true;
        refreshAll({ force: addressChanged }).finally(() => {
          initializingRef.current = false;
        });
      }
    }
  }, [address, debouncedPortfolioHash, refreshAll]);
  
  // ============================================================================
  // Listen for AI events
  // ============================================================================
  
  useEffect(() => {
    const unsubscribe = onAIEvent('ai:cache:invalidated', () => {
      logger.debug('[AIDecisionsContext] External cache invalidation detected');
      if (address) {
        refreshAll({ force: true });
      }
    });
    
    return unsubscribe;
  }, [address, refreshAll]);
  
  // ============================================================================
  // AI Manager Integration - Continuous management with WebSocket + scheduling
  // ============================================================================
  
  useEffect(() => {
    // Start the AI Manager if not already running
    const status = AIManager.getStatus();
    if (!status.isRunning) {
      logger.info('[AIDecisionsContext] Starting AI Manager for continuous operation');
      AIManager.start({
        enableWebSocket: true,
        enableScheduler: true,
        enableHealthCheck: true,
      });
    }
    
    // AI Manager handles all service scheduling, price monitoring, and recovery automatically
    // No need to manually manage price monitoring here anymore
    
    return () => {
      // Don't stop AIManager on context unmount - let it run in background
      // Other components may still need it
    };
  }, []);
  
  // ============================================================================
  // Smart Price Monitoring - Legacy fallback (AIManager takes priority)
  // ============================================================================
  
  useEffect(() => {
    // Only run manual price monitoring if AIManager WebSocket is not connected
    const status = AIManager.getStatus();
    if (status.websocketConnected) {
      // AIManager handles price streaming via WebSocket
      return;
    }
    
    // Fallback: Extract asset symbols from portfolio positions
    const assets = positionsData?.positions
      ?.map(p => p.symbol?.toUpperCase())
      .filter((s): s is string => !!s) || ['BTC', 'ETH', 'CRO'];
    
    // Ensure we track common assets
    const trackedAssets = [...new Set([...assets, 'BTC', 'ETH'])];
    
    // Start price monitoring with 15s interval (fallback only)
    AIPriceIntegration.startPriceMonitoring(trackedAssets, 15000);
    
    // Listen for price updates and check for cache invalidation
    const unsubscribe = onPriceUpdate(() => {
      // Check each service type for price-based invalidation
      const shouldRefreshHedges = AIPriceIntegration.shouldInvalidateCache('hedges');
      const shouldRefreshRisk = AIPriceIntegration.shouldInvalidateCache('risk');
      
      // Use AIManager's priority queue for refreshes
      if (shouldRefreshHedges && address && !state.hedgesLoading) {
        AIManager.forceRefresh('hedges');
      }
      
      if (shouldRefreshRisk && address && !state.riskLoading) {
        AIManager.forceRefresh('risk');
      }
    });
    
    return () => {
      unsubscribe();
      AIPriceIntegration.stopPriceMonitoring();
    };
  }, [address, positionsData?.positions, state.hedgesLoading, state.riskLoading]);
  
  // ============================================================================
  // Computed Values
  // ============================================================================
  
  const hasAnyLoading = useMemo(() => {
    return state.riskLoading || state.hedgesLoading || state.insightsLoading || state.actionLoading;
  }, [state.riskLoading, state.hedgesLoading, state.insightsLoading, state.actionLoading]);
  
  const hasAnyError = useMemo(() => {
    return !!(state.riskError || state.hedgesError || state.insightsError || state.actionError);
  }, [state.riskError, state.hedgesError, state.insightsError, state.actionError]);
  
  const hasStaleData = useMemo(() => {
    if (!state.isInitialized) return true;
    const age = Date.now() - state.lastUpdated;
    return age > 60000; // Stale after 60 seconds
  }, [state.lastUpdated, state.isInitialized]);
  
  const topHedge = useMemo(() => {
    if (state.hedges.length === 0) return null;
    return state.hedges.reduce((best, current) => 
      current.confidence > best.confidence ? current : best
    );
  }, [state.hedges]);
  
  const marketSentiment = useMemo(() => {
    // Priority: insights > risk analysis > neutral
    if (state.insights?.sentiment) return state.insights.sentiment;
    if (state.risk?.marketSentiment) return state.risk.marketSentiment;
    return 'neutral';
  }, [state.insights, state.risk]);
  
  const recommendedAction = useMemo(() => {
    return state.action?.action || null;
  }, [state.action]);
  
  // ============================================================================
  // Context Value
  // ============================================================================
  
  const contextValue = useMemo<AIDecisionsContextType>(() => ({
    state,
    refreshRisk,
    refreshHedges,
    refreshInsights,
    refreshAction,
    refreshAll,
    invalidateAll,
    getCacheStatus,
    hasAnyLoading,
    hasAnyError,
    hasStaleData,
    topHedge,
    marketSentiment,
    recommendedAction,
    requestCustomAction,
  }), [
    state, 
    refreshRisk, 
    refreshHedges, 
    refreshInsights, 
    refreshAction, 
    refreshAll, 
    invalidateAll,
    getCacheStatus,
    hasAnyLoading, 
    hasAnyError, 
    hasStaleData, 
    topHedge, 
    marketSentiment, 
    recommendedAction,
    requestCustomAction
  ]);
  
  return (
    <AIDecisionsContext.Provider value={contextValue}>
      {children}
    </AIDecisionsContext.Provider>
  );
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Main hook - access all AI decisions
 */
export function useAIDecisions() {
  const context = useContext(AIDecisionsContext);
  if (context === undefined) {
    throw new Error('useAIDecisions must be used within an AIDecisionsProvider');
  }
  return context;
}

/**
 * Hook for risk analysis only
 */
export function useRiskAnalysis() {
  const { state, refreshRisk } = useAIDecisions();
  return {
    risk: state.risk,
    loading: state.riskLoading,
    error: state.riskError,
    refresh: refreshRisk,
  };
}

/**
 * Hook for hedge recommendations only
 */
export function useHedgeRecommendations() {
  const { state, refreshHedges, topHedge } = useAIDecisions();
  return {
    hedges: state.hedges,
    topHedge,
    loading: state.hedgesLoading,
    error: state.hedgesError,
    refresh: refreshHedges,
  };
}

/**
 * Hook for market insights only
 */
export function useMarketInsights() {
  const { state, refreshInsights, marketSentiment } = useAIDecisions();
  return {
    insights: state.insights,
    sentiment: marketSentiment,
    loading: state.insightsLoading,
    error: state.insightsError,
    refresh: refreshInsights,
  };
}

/**
 * Hook for portfolio action only
 */
export function usePortfolioAction() {
  const { state, refreshAction, recommendedAction, requestCustomAction } = useAIDecisions();
  return {
    action: state.action,
    recommendedAction,
    loading: state.actionLoading,
    error: state.actionError,
    refresh: refreshAction,
    requestCustomAction,
  };
}
