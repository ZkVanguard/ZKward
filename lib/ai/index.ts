/**
 * AI Decisions - Unified Exports
 * ===============================
 * Single import point for all AI decision-related functionality.
 * 
 * Usage:
 * ```tsx
 * // Context hooks
 * import { useAIDecisions, useRiskAnalysis, useHedgeRecommendations } from '@/lib/ai';
 * 
 * // Service functions
 * import { AIDecisions } from '@/lib/ai';
 * 
 * // Types
 * import type { RiskAnalysis, HedgeRecommendation, InsightSummary } from '@/lib/ai';
 * ```
 */

// ============================================================================
// Service Layer - Direct API access with caching
// ============================================================================
export { 
  AIDecisions,
  fetchRiskAnalysis,
  fetchHedgeRecommendations,
  fetchInsightSummary,
  fetchPortfolioAction,
  fetchCustomPortfolioAction,
  fetchAllAIDecisions,
  invalidateAllCache,
  invalidateCache,
  getCacheStatus,
  onAIEvent,
} from '@/lib/services/ai-decisions';

// ============================================================================
// Types
// ============================================================================
export type {
  RiskAnalysis,
  HedgeRecommendation,
  InsightSummary,
  PortfolioAction,
  TokenDirection,
  LeverageRecommendation,
  AIDecisionsState,
  AIEvent,
  FetchAllResult,
  CustomActionPayload,
} from '@/lib/services/ai-decisions';

// ============================================================================
// Context & Hooks - React integration
// ============================================================================
export {
  AIDecisionsProvider,
  useAIDecisions,
  useRiskAnalysis,
  useHedgeRecommendations,
  useMarketInsights,
  usePortfolioAction,
} from '@/contexts/AIDecisionsContext';

export type {
  AIDecisionsContextType,
} from '@/contexts/AIDecisionsContext';

// ============================================================================
// Price Integration - Live price context for AI services
// ============================================================================
export {
  AIPriceIntegration,
  getCurrentPrices,
  getPrice,
  getPriceChange,
  refreshPrices,
  startPriceMonitoring,
  stopPriceMonitoring,
  onPriceUpdate,
  getRiskPriceContext,
  getHedgePriceContext,
  getInsightPriceContext,
  getActionPriceContext,
  SERVICE_CONFIGS,
} from '@/lib/services/ai-price-integration';

export type {
  ServiceConfig,
  RiskPriceContext,
  HedgePriceContext,
  InsightPriceContext,
  ActionPriceContext,
} from '@/lib/services/ai-price-integration';

// ============================================================================
// Continuous Management - Production-grade AI operations manager
// ============================================================================
export {
  AIManager,
} from '@/lib/services/ai-manager';

export type {
  AIServiceType,
  TaskPriority,
  ServiceHealth,
  ScheduledTask,
  ServiceStatus,
  AIManagerState,
  QueuedRequest,
  ManagerMetrics,
} from '@/lib/services/ai-manager';

// ============================================================================
// React Hooks - For components that need AI management
// ============================================================================
export {
  useAIManager,
} from '@/lib/hooks/useAIManager';

export type {
  UseAIManagerReturn,
} from '@/lib/hooks/useAIManager';
// ============================================================================
// Unified Price Provider - Real-time prices for all services
// ============================================================================
export {
  getUnifiedPriceProvider,
  getLivePrice,
  getHedgeExecutionPrice,
  validatePriceForHedge,
  UnifiedPriceProvider,
} from '@/lib/services/market-data/unified-price-provider';

export type {
  LivePrice,
  PriceValidation,
  HedgePriceContext as UnifiedHedgePriceContext,
} from '@/lib/services/market-data/unified-price-provider';

// ============================================================================
// Background Hedge Controller - Intelligent background hedging
// ============================================================================
export {
  getBackgroundHedgeController,
  BackgroundHedgeController,
} from '@/lib/services/hedging/background-hedge-controller';

export type {
  HedgeIntent,
  HedgeValidation,
  HedgeExecution,
  ControllerStatus,
} from '@/lib/services/hedging/background-hedge-controller';