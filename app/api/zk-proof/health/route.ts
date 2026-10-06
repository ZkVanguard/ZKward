/**
 * ZK Proof Backend Health Check
 * Checks the Python CUDA-accelerated ZK-STARK backend
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

// The prover address is ZK_API_URL, the same variable the other proof routes read.
// No default host: an unset address must fail closed (.invalid never resolves).
const ZK_BACKEND_URL = (process.env.ZK_API_URL || process.env.ZK_BACKEND_URL || '').trim() || 'http://prover.invalid';

export async function GET() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const res = await fetch(`${ZK_BACKEND_URL}/health`, {
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    if (res.ok) {
      const data = await res.json();
      return NextResponse.json({
        status: 'healthy',
        backend: ZK_BACKEND_URL,
        cuda_available: data.cuda_available || false,
        cuda_enabled: data.cuda_enabled || false,
        system_info: data.system_info || {},
        timestamp: Date.now(),
      }, {
        // Backend health rarely flips minute-to-minute; 30s cache
        // is safe and saves the external fetch per request.
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      });
    }
    
    // Return 200 with status='unhealthy' in the body. This is a health
    // reporter, not a health signal to a load balancer — a 503 HTTP code
    // just makes the browser log a console error on the /zk page while
    // the client already reads .status from the body. The `status` field
    // carries the actual liveness signal.
    return NextResponse.json({
      status: 'unhealthy',
      backend: ZK_BACKEND_URL,
      error: `Backend returned ${res.status}`,
      timestamp: Date.now(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });

  } catch (error) {
    return NextResponse.json({
      status: 'unavailable',
      backend: ZK_BACKEND_URL,
      error: error instanceof Error ? error.message : 'Connection failed',
      timestamp: Date.now(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  }
}
