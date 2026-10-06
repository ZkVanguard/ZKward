/**
 * Agent Control API
 * POST/GET /api/agents/monitor
 * 
 * Control the autonomous price monitoring agent
 */

import { NextRequest, NextResponse } from 'next/server';
import { mutationLimiter } from '@/lib/security/rate-limiter';
import { verifyCronRequest } from '@/lib/qstash';
import { 
  PriceMonitorAgent,
  PriceAlert, 
  AgentStatus, 
  PriceData
} from '@/agents/specialized/PriceMonitorAgent';
import { logger } from '@/lib/utils/logger';

export const runtime = 'nodejs';

export const maxDuration = 30;
// Lazy singleton — only this route uses it directly.
// The orchestrator manages its own independent instance for centralized data flow.
let _priceMonitorAgent: PriceMonitorAgent | null = null;
function getPriceMonitorAgent(): PriceMonitorAgent {
  if (!_priceMonitorAgent) {
    _priceMonitorAgent = new PriceMonitorAgent();
  }
  return _priceMonitorAgent;
}
const priceMonitorAgent = new Proxy({} as PriceMonitorAgent, {
  get(_target, prop) {
    return (getPriceMonitorAgent() as any)[prop];
  },
});

export interface MonitorControlRequest {
  action: 'start' | 'stop' | 'status' | 'add_alert' | 'remove_alert' | 'get_prices';
  alert?: Omit<PriceAlert, 'id' | 'createdAt'>;
  alertId?: string;
  symbol?: string;
  limit?: number;
}

export interface MonitorControlResponse {
  success: boolean;
  data?: {
    status?: AgentStatus;
    alertId?: string;
    alerts?: PriceAlert[];
    prices?: Record<string, PriceData>;
    history?: PriceData[];
  };
  error?: string;
}

// Store for streaming connections
const _eventClients = new Set<ReadableStreamDefaultController>();

export async function POST(request: NextRequest): Promise<NextResponse<MonitorControlResponse | unknown>> {
  const rateLimited = mutationLimiter.check(request);
  if (rateLimited) return rateLimited;

  const authResult = await verifyCronRequest(request, 'agents/monitor');
  if (authResult !== true) return authResult;

  try {
    const body = await request.json() as MonitorControlRequest;
    
    switch (body.action) {
      case 'start': {
        await priceMonitorAgent.start();
        return NextResponse.json({
          success: true,
          data: { status: priceMonitorAgent.getStatus() },
        });
      }
      
      case 'stop': {
        priceMonitorAgent.stop();
        return NextResponse.json({
          success: true,
          data: { status: priceMonitorAgent.getStatus() },
        });
      }
      
      case 'status': {
        return NextResponse.json({
          success: true,
          data: {
            status: priceMonitorAgent.getStatus(),
            alerts: priceMonitorAgent.getAlerts(),
          },
        });
      }
      
      case 'add_alert': {
        if (!body.alert) {
          return NextResponse.json(
            { success: false, error: 'Missing alert configuration' },
            { status: 400 }
          );
        }
        const alertId = priceMonitorAgent.addAlert(body.alert);
        return NextResponse.json({
          success: true,
          data: { alertId, alerts: priceMonitorAgent.getAlerts() },
        });
      }
      
      case 'remove_alert': {
        if (!body.alertId) {
          return NextResponse.json(
            { success: false, error: 'Missing alertId' },
            { status: 400 }
          );
        }
        const removed = priceMonitorAgent.removeAlert(body.alertId);
        return NextResponse.json({
          success: removed,
          data: { alerts: priceMonitorAgent.getAlerts() },
          error: removed ? undefined : 'Alert not found',
        });
      }
      
      case 'get_prices': {
        const prices: Record<string, PriceData> = {};
        const symbols = body.symbol ? [body.symbol] : ['BTC', 'ETH', 'CRO'];
        
        for (const symbol of symbols) {
          const price = priceMonitorAgent.getCurrentPrice(symbol);
          if (price) prices[symbol] = price;
        }
        
        // Get history if requested for single symbol
        let history: PriceData[] | undefined;
        if (body.symbol) {
          history = priceMonitorAgent.getPriceHistory(body.symbol, Math.min(body.limit || 100, 500));
        }
        
        return NextResponse.json({
          success: true,
          data: { prices, history },
        });
      }
      
      default:
        return NextResponse.json(
          { success: false, error: `Unknown action: ${body.action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    logger.error('[agents/monitor] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/agents/monitor - Get current status
 */
export async function GET(): Promise<NextResponse<MonitorControlResponse>> {
  try {
    const status = priceMonitorAgent.getStatus();
    const alerts = priceMonitorAgent.getAlerts();
    
    // Get current prices
    const prices: Record<string, PriceData> = {};
    for (const symbol of ['BTC', 'ETH', 'CRO']) {
      const price = priceMonitorAgent.getCurrentPrice(symbol);
      if (price) prices[symbol] = price;
    }
    
    return NextResponse.json({
      success: true,
      data: { status, alerts, prices },
    });
  } catch (error) {
    logger.error('[agents/monitor] GET error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to get agent status' },
      { status: 500 }
    );
  }
}
