/**
 * AI Continuous Management Service
 * ==================================
 * Production-grade service for continuous AI operation management.
 * Handles WebSocket streaming, task scheduling, health monitoring,
 * rate limiting, and graceful recovery.
 *
 * Features:
 * - WebSocket price streaming (no polling overhead)
 * - Priority-based task queue
 * - Exponential backoff for failures
 * - Health monitoring with auto-recovery
 * - Persistent state across page reloads
 * - Graceful degradation when services fail
 */

import { logger } from '@/lib/utils/logger';
import crypto from 'crypto';
import { AIPriceIntegration, SERVICE_CONFIGS } from './ai-price-integration';
import { onAIEvent, invalidateCache, AIEvent } from './ai-decisions'; // ============================================================================
// Types
// ============================================================================

export type AIServiceType = 'risk' | 'hedges' | 'insights' | 'action';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
export type ServiceHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface ScheduledTask {
  id: string;
  serviceType: AIServiceType;
  priority: TaskPriority;
  intervalMs: number;
  lastRun: number;
  nextRun: number;
  failures: number;
  enabled: boolean;
  callback: () => Promise<void>;
}

export interface ServiceStatus {
  type: AIServiceType;
  health: ServiceHealth;
  lastSuccess: number;
  lastError: number | null;
  errorCount: number;
  consecutiveFailures: number;
  avgResponseTime: number;
  isProcessing: boolean;
}

export interface AIManagerState {
  isRunning: boolean;
  startedAt: number | null;
  websocketConnected: boolean;
  tasks: Map<string, ScheduledTask>;
  services: Map<AIServiceType, ServiceStatus>;
  pendingQueue: QueuedRequest[];
  metrics: ManagerMetrics;
}

export interface QueuedRequest {
  id: string;
  serviceType: AIServiceType;
  priority: TaskPriority;
  queuedAt: number;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  execute: () => Promise<void>;
}

export interface ManagerMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatency: number;
  uptime: number;
  lastHealthCheck: number;
}

// ============================================================================
// Constants
// ============================================================================

const PRIORITY_WEIGHTS: Record<TaskPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const DEFAULT_INTERVALS: Record<AIServiceType, number> = {
  risk: 60000, // 1 minute
  hedges: 30000, // 30 seconds
  insights: 120000, // 2 minutes
  action: 45000, // 45 seconds
};

const MAX_CONSECUTIVE_FAILURES = 5;
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const QUEUE_PROCESS_INTERVAL = 1000; // 1 second
const WEBSOCKET_RECONNECT_DELAY = 5000;
const WEBSOCKET_MAX_RETRIES = 3;
const PERSISTENCE_KEY = 'ai_manager_state';

// ============================================================================
// AI Manager Class
// ============================================================================

class AIManagerService {
  private state: AIManagerState;
  private schedulerInterval: NodeJS.Timeout | null = null;
  private queueInterval: NodeJS.Timeout | null = null;
  private healthInterval: NodeJS.Timeout | null = null;
  private websocket: WebSocket | null = null;
  private websocketReconnectTimeout: NodeJS.Timeout | null = null;
  private websocketRetryCount = 0;
  private eventUnsubscribes: Array<() => void> = [];

  constructor() {
    this.state = this.createInitialState();
    this.loadPersistedState();
  }

  private createInitialState(): AIManagerState {
    const services = new Map<AIServiceType, ServiceStatus>();
    const serviceTypes: AIServiceType[] = ['risk', 'hedges', 'insights', 'action'];

    serviceTypes.forEach((type) => {
      services.set(type, {
        type,
        health: 'unknown',
        lastSuccess: 0,
        lastError: null,
        errorCount: 0,
        consecutiveFailures: 0,
        avgResponseTime: 0,
        isProcessing: false,
      });
    });

    return {
      isRunning: false,
      startedAt: null,
      websocketConnected: false,
      tasks: new Map(),
      services,
      pendingQueue: [],
      metrics: {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        averageLatency: 0,
        uptime: 0,
        lastHealthCheck: 0,
      },
    };
  }

  // ============================================================================
  // Lifecycle Management
  // ============================================================================

  /**
   * Start the AI manager with all continuous operations
   */
  start(options?: {
    enableWebSocket?: boolean;
    enableScheduler?: boolean;
    enableHealthCheck?: boolean;
  }): void {
    if (this.state.isRunning) {
      logger.warn('[AIManager] Already running');
      return;
    }

    const {
      enableWebSocket = true,
      enableScheduler = true,
      enableHealthCheck = true,
    } = options || {};

    logger.info('[AIManager] Starting continuous management');

    this.state.isRunning = true;
    this.state.startedAt = Date.now();

    // Start components
    if (enableWebSocket) {
      this.connectWebSocket();
    }

    if (enableScheduler) {
      this.startScheduler();
    }

    if (enableHealthCheck) {
      this.startHealthCheck();
    }

    // Start queue processor
    this.startQueueProcessor();

    // Subscribe to AI events
    this.subscribeToEvents();

    // Persist state
    this.persistState();

    logger.info('[AIManager] Started successfully');
  }

  /**
   * Stop all continuous operations gracefully
   */
  stop(): void {
    if (!this.state.isRunning) {
      logger.warn('[AIManager] Not running');
      return;
    }

    logger.info('[AIManager] Stopping...');

    // Clear intervals
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }

    if (this.queueInterval) {
      clearInterval(this.queueInterval);
      this.queueInterval = null;
    }

    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }

    // Close WebSocket
    this.disconnectWebSocket();

    // Unsubscribe from events
    this.eventUnsubscribes.forEach((unsub) => unsub());
    this.eventUnsubscribes = [];

    // Stop price monitoring
    AIPriceIntegration.stopPriceMonitoring();

    this.state.isRunning = false;
    this.persistState();

    logger.info('[AIManager] Stopped');
  }

  /**
   * Restart the manager (useful for recovery)
   */
  restart(): void {
    logger.info('[AIManager] Restarting...');
    this.stop();
    setTimeout(() => this.start(), 1000);
  }

  // ============================================================================
  // WebSocket Price Streaming
  // ============================================================================

  private connectWebSocket(): void {
    // Use Crypto.com WebSocket API for real-time prices
    const wsUrl = 'wss://stream.crypto.com/exchange/v1/market';

    try {
      this.websocket = new WebSocket(wsUrl);

      this.websocket.onopen = () => {
        logger.info('[AIManager] WebSocket connected');
        this.state.websocketConnected = true;
        this.websocketRetryCount = 0; // Reset on successful connection

        // Subscribe to price channels for common assets
        this.subscribeToChannels(['BTC_USD', 'ETH_USD', 'CRO_USD', 'SUI_USD']);
      };

      this.websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleWebSocketMessage(data);
        } catch (e) {
          logger.error(
            '[AIManager] Failed to parse WebSocket message',
            e instanceof Error ? e : undefined
          );
        }
      };

      this.websocket.onerror = () => {
        // Event has no useful detail (browser redacts for security) and
        // onclose fires next with the actual close code + drives reconnect
        // and REST fallback. Just mark disconnected — no log to avoid
        // "WebSocket error {error: undefined}" noise on every bfcache exit.
        this.state.websocketConnected = false;
      };

      this.websocket.onclose = () => {
        this.state.websocketConnected = false;
        this.websocketRetryCount++;

        // Schedule reconnection with exponential backoff, up to max retries
        if (this.state.isRunning && this.websocketRetryCount <= WEBSOCKET_MAX_RETRIES) {
          const delay = WEBSOCKET_RECONNECT_DELAY * Math.pow(2, this.websocketRetryCount - 1);
          logger.debug(
            `[AIManager] WebSocket disconnected, retry ${this.websocketRetryCount}/${WEBSOCKET_MAX_RETRIES} in ${delay}ms`
          );
          this.websocketReconnectTimeout = setTimeout(() => {
            this.connectWebSocket();
          }, delay);
        } else if (this.websocketRetryCount > WEBSOCKET_MAX_RETRIES) {
          logger.info('[AIManager] WebSocket unavailable, using REST price polling instead');
          AIPriceIntegration.startPriceMonitoring(['BTC', 'ETH', 'CRO', 'SUI'], 15000);
        }
      };
    } catch (error) {
      logger.error(
        '[AIManager] Failed to connect WebSocket',
        error instanceof Error ? error : undefined
      );
      // Fall back to polling
      AIPriceIntegration.startPriceMonitoring(['BTC', 'ETH', 'CRO'], 15000);
    }
  }

  private subscribeToChannels(instruments: string[]): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;

    const subscribeMsg = {
      id: Date.now(),
      method: 'subscribe',
      params: {
        channels: instruments.map((i) => `ticker.${i}`),
      },
    };

    this.websocket.send(JSON.stringify(subscribeMsg));
    logger.debug('[AIManager] Subscribed to price channels', { instruments });
  }

  private handleWebSocketMessage(data: Record<string, unknown>): void {
    if (data.method === 'subscribe' && data.result) {
      logger.debug('[AIManager] Subscription confirmed');
      return;
    }

    const result = data.result as { channel?: string; data?: unknown } | undefined;
    if (result?.channel?.startsWith('ticker.')) {
      const ticker = result.data as Array<{
        i: string;
        a: string;
        c: string;
      }>;

      if (ticker && ticker[0]) {
        const symbol = ticker[0].i.replace('_USD', '');
        const price = parseFloat(ticker[0].a);
        const change = parseFloat(ticker[0].c);

        // Check if price change warrants cache invalidation
        this.checkPriceTriggeredRefresh(symbol, price, change);
      }
    }
  }

  private checkPriceTriggeredRefresh(symbol: string, price: number, change24h: number): void {
    // Check each service's invalidation threshold
    const services: AIServiceType[] = ['hedges', 'risk', 'action', 'insights'];

    for (const service of services) {
      const config = SERVICE_CONFIGS[service];
      if (Math.abs(change24h) >= config.invalidationThreshold) {
        // Queue a high-priority refresh
        this.queueRequest(service, 'high', async () => {
          invalidateCache(service);
        });

        logger.info(`[AIManager] Price-triggered refresh for ${service}`, {
          symbol,
          change: `${change24h.toFixed(2)}%`,
          threshold: `${config.invalidationThreshold}%`,
        });
      }
    }
  }

  private disconnectWebSocket(): void {
    if (this.websocketReconnectTimeout) {
      clearTimeout(this.websocketReconnectTimeout);
      this.websocketReconnectTimeout = null;
    }

    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }

    this.state.websocketConnected = false;
  }

  // ============================================================================
  // Task Scheduler
  // ============================================================================

  private startScheduler(): void {
    // Register default tasks
    this.registerDefaultTasks();

    // Process scheduler every second
    this.schedulerInterval = setInterval(() => {
      this.processScheduledTasks();
    }, 1000);

    logger.info('[AIManager] Scheduler started');
  }

  private registerDefaultTasks(): void {
    const serviceTypes: AIServiceType[] = ['risk', 'hedges', 'insights', 'action'];

    serviceTypes.forEach((type) => {
      const config = SERVICE_CONFIGS[type];
      this.registerTask({
        id: `auto-${type}`,
        serviceType: type,
        priority: config.priority as TaskPriority,
        intervalMs: DEFAULT_INTERVALS[type],
        callback: async () => {
          // This will be executed by queue processor
          invalidateCache(type);
        },
      });
    });
  }

  registerTask(task: Omit<ScheduledTask, 'lastRun' | 'nextRun' | 'failures' | 'enabled'>): void {
    const fullTask: ScheduledTask = {
      ...task,
      lastRun: 0,
      nextRun: Date.now() + task.intervalMs,
      failures: 0,
      enabled: true,
    };

    this.state.tasks.set(task.id, fullTask);
    logger.debug(`[AIManager] Registered task: ${task.id}`);
  }

  private processScheduledTasks(): void {
    const now = Date.now();

    this.state.tasks.forEach((task, _id) => {
      if (!task.enabled) return;
      if (now < task.nextRun) return;

      // Check if service is healthy enough to run
      const serviceStatus = this.state.services.get(task.serviceType);
      if ((serviceStatus?.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
        // Skip but reschedule with backoff
        task.nextRun = now + task.intervalMs * Math.pow(2, task.failures);
        return;
      }

      // Queue the task
      this.queueRequest(task.serviceType, task.priority, task.callback);

      // Update task timing
      task.lastRun = now;
      task.nextRun = now + task.intervalMs;
    });
  }

  // ============================================================================
  // Priority Queue
  // ============================================================================

  private startQueueProcessor(): void {
    this.queueInterval = setInterval(() => {
      this.processQueue();
    }, QUEUE_PROCESS_INTERVAL);

    logger.info('[AIManager] Queue processor started');
  }

  queueRequest(
    serviceType: AIServiceType,
    priority: TaskPriority,
    execute: () => Promise<void>
  ): string {
    const id = `req-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

    const request: QueuedRequest = {
      id,
      serviceType,
      priority,
      queuedAt: Date.now(),
      attempts: 0,
      maxAttempts: 3,
      backoffMs: 1000,
      execute,
    };

    // Insert in priority order
    const insertIndex = this.state.pendingQueue.findIndex(
      (r) => PRIORITY_WEIGHTS[r.priority] < PRIORITY_WEIGHTS[priority]
    );

    if (insertIndex === -1) {
      this.state.pendingQueue.push(request);
    } else {
      this.state.pendingQueue.splice(insertIndex, 0, request);
    }

    return id;
  }

  private async processQueue(): Promise<void> {
    if (this.state.pendingQueue.length === 0) return;

    // Get next request
    const request = this.state.pendingQueue[0];
    if (!request) return;

    // Check if service is processing
    const serviceStatus = this.state.services.get(request.serviceType);
    if (serviceStatus?.isProcessing) return;

    // Check backoff
    const backoffUntil = request.queuedAt + request.backoffMs * Math.pow(2, request.attempts);
    if (Date.now() < backoffUntil) return;

    // Remove from queue
    this.state.pendingQueue.shift();

    // Mark service as processing
    if (serviceStatus) {
      serviceStatus.isProcessing = true;
    }

    // Execute with timing
    const startTime = Date.now();
    request.attempts++;
    this.state.metrics.totalRequests++;

    try {
      await request.execute();

      // Success
      const latency = Date.now() - startTime;
      this.recordSuccess(request.serviceType, latency);
    } catch (error) {
      logger.error(
        `[AIManager] Request failed: ${request.id}`,
        error instanceof Error ? error : undefined
      );
      this.recordFailure(request.serviceType);

      // Re-queue if attempts remain
      if (request.attempts < request.maxAttempts) {
        request.backoffMs *= 2; // Exponential backoff
        this.state.pendingQueue.push(request);
      }
    } finally {
      if (serviceStatus) {
        serviceStatus.isProcessing = false;
      }
    }
  }

  private recordSuccess(serviceType: AIServiceType, latency: number): void {
    const status = this.state.services.get(serviceType);
    if (!status) return;

    status.lastSuccess = Date.now();
    status.consecutiveFailures = 0;
    status.health = 'healthy';

    // Update average response time (moving average)
    status.avgResponseTime =
      status.avgResponseTime === 0 ? latency : status.avgResponseTime * 0.8 + latency * 0.2;

    this.state.metrics.successfulRequests++;
    this.state.metrics.averageLatency = this.state.metrics.averageLatency * 0.9 + latency * 0.1;
  }

  private recordFailure(serviceType: AIServiceType): void {
    const status = this.state.services.get(serviceType);
    if (!status) return;

    status.lastError = Date.now();
    status.errorCount++;
    status.consecutiveFailures++;

    // Update health status
    if (status.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      status.health = 'unhealthy';
    } else if (status.consecutiveFailures >= 2) {
      status.health = 'degraded';
    }

    this.state.metrics.failedRequests++;
  }

  // ============================================================================
  // Health Monitoring
  // ============================================================================

  private startHealthCheck(): void {
    this.healthInterval = setInterval(() => {
      this.performHealthCheck();
    }, HEALTH_CHECK_INTERVAL);

    logger.info('[AIManager] Health monitoring started');
  }

  private performHealthCheck(): void {
    const now = Date.now();
    this.state.metrics.lastHealthCheck = now;
    this.state.metrics.uptime = this.state.startedAt ? now - this.state.startedAt : 0;

    this.state.services.forEach((status, type) => {
      // Check for stale data
      const staleness = now - status.lastSuccess;
      const expectedInterval = DEFAULT_INTERVALS[type];

      if (status.lastSuccess > 0 && staleness > expectedInterval * 3) {
        status.health = 'degraded';
      }

      // Check if stuck in processing
      if (status.isProcessing && staleness > 60000) {
        status.isProcessing = false;
        status.health = 'degraded';
      }

      // Auto-recover unhealthy services
      if (status.health === 'unhealthy' && status.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Reset failures to allow retry
        if (staleness > 300000) {
          // 5 minutes
          status.consecutiveFailures = 0;
          status.health = 'degraded';
          logger.info(`[AIManager] Auto-recovering ${type} service`);
        }
      }
    });

    // Log health summary periodically
    if (now % 60000 < HEALTH_CHECK_INTERVAL) {
      this.logHealthSummary();
    }

    this.persistState();
  }

  private logHealthSummary(): void {
    const summary: Record<string, ServiceHealth> = {};
    this.state.services.forEach((status, type) => {
      summary[type] = status.health;
    });

    logger.info('[AIManager] Health summary', {
      services: summary,
      queue: this.state.pendingQueue.length,
      uptime: `${Math.round(this.state.metrics.uptime / 60000)}m`,
      websocket: this.state.websocketConnected ? 'connected' : 'disconnected',
      successRate:
        this.state.metrics.totalRequests > 0
          ? `${Math.round((this.state.metrics.successfulRequests / this.state.metrics.totalRequests) * 100)}%`
          : 'N/A',
    });
  }

  // ============================================================================
  // Event Subscriptions
  // ============================================================================

  private subscribeToEvents(): void {
    // Listen for cache invalidation events
    const unsubInvalidate = onAIEvent('ai:cache:invalidated', (event: AIEvent) => {
      logger.debug('[AIManager] Cache invalidated event received', { data: event.data });
    });

    this.eventUnsubscribes.push(unsubInvalidate);
  }

  // ============================================================================
  // State Persistence
  // ============================================================================

  private persistState(): void {
    if (typeof window === 'undefined') return;

    try {
      const persistable = {
        metrics: this.state.metrics,
        services: Array.from(this.state.services.entries()).map(([k, v]) => ({
          type: k,
          health: v.health,
          lastSuccess: v.lastSuccess,
          errorCount: v.errorCount,
        })),
        startedAt: this.state.startedAt,
      };

      localStorage.setItem(PERSISTENCE_KEY, JSON.stringify(persistable));
    } catch (e) {
      // Ignore storage errors
    }
  }

  private loadPersistedState(): void {
    if (typeof window === 'undefined') return;

    try {
      const stored = localStorage.getItem(PERSISTENCE_KEY);
      if (!stored) return;

      const data = JSON.parse(stored);

      // Restore metrics
      if (data.metrics) {
        this.state.metrics = { ...this.state.metrics, ...data.metrics };
      }

      // Restore service states
      if (data.services) {
        data.services.forEach(
          (s: {
            type: AIServiceType;
            health: ServiceHealth;
            lastSuccess: number;
            errorCount: number;
          }) => {
            const existing = this.state.services.get(s.type);
            if (existing) {
              existing.health = s.health;
              existing.lastSuccess = s.lastSuccess;
              existing.errorCount = s.errorCount;
            }
          }
        );
      }

      logger.debug('[AIManager] Restored persisted state');
    } catch (e) {
      // Ignore parse errors
    }
  }

  // ============================================================================
  // Public API
  // ============================================================================

  getStatus(): {
    isRunning: boolean;
    websocketConnected: boolean;
    services: Record<AIServiceType, ServiceStatus>;
    queueLength: number;
    metrics: ManagerMetrics;
  } {
    const services: Record<AIServiceType, ServiceStatus> = {} as Record<
      AIServiceType,
      ServiceStatus
    >;
    this.state.services.forEach((v, k) => {
      services[k] = { ...v };
    });

    return {
      isRunning: this.state.isRunning,
      websocketConnected: this.state.websocketConnected,
      services,
      queueLength: this.state.pendingQueue.length,
      metrics: { ...this.state.metrics },
    };
  }

  getServiceHealth(type: AIServiceType): ServiceHealth {
    return this.state.services.get(type)?.health || 'unknown';
  }

  forceRefresh(type: AIServiceType): void {
    this.queueRequest(type, 'critical', async () => {
      invalidateCache(type);
    });
  }

  pauseService(type: AIServiceType): void {
    const task = this.state.tasks.get(`auto-${type}`);
    if (task) {
      task.enabled = false;
      logger.info(`[AIManager] Paused ${type} service`);
    }
  }

  resumeService(type: AIServiceType): void {
    const task = this.state.tasks.get(`auto-${type}`);
    if (task) {
      task.enabled = true;
      task.nextRun = Date.now();
      logger.info(`[AIManager] Resumed ${type} service`);
    }
  }

  setServiceInterval(type: AIServiceType, intervalMs: number): void {
    const task = this.state.tasks.get(`auto-${type}`);
    if (task) {
      task.intervalMs = intervalMs;
      logger.info(`[AIManager] Set ${type} interval to ${intervalMs}ms`);
    }
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const AIManager = new AIManagerService();
export default AIManager;
