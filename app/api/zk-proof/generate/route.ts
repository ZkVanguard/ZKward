import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { ProductionGuard } from '@/lib/security/production-guard';
import { heavyLimiter } from '@/lib/security/rate-limiter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// No default host: an unset address must fail closed (.invalid never resolves).
const ZK_API_URL = (process.env.ZK_API_URL || '').trim() || 'http://prover.invalid';

// Generate deterministic fallback proof when ZK backend unavailable
function generateFallbackProof(scenario: string, statement: Record<string, unknown>, _witness: Record<string, unknown>) {
  const timestamp = Date.now();
  const hashInput = `${scenario}-${JSON.stringify(statement)}-${timestamp}`;
  const proofHash = `0x${Array.from(hashInput).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0').slice(0, 64)}`;
  const merkleRoot = `0x${Array.from(`merkle-${hashInput}`).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0').slice(0, 64)}`;
  
  logger.warn('[ZK FALLBACK] Real ZK server unavailable - using deterministic fallback');
  
  return {
    success: true,
    proof: {
      proof_hash: proofHash,
      merkle_root: merkleRoot,
      timestamp,
      verified: false, // Mark as unverified since this is fallback
      protocol: 'ZK-STARK (Fallback)',
      security_level: 0,
      field_bits: 0,
      cuda_accelerated: false,
      fallback_mode: true,
    },
    claim: {
      scenario,
      timestamp,
      verified: false,
    },
    statement,
    scenario,
    duration_ms: 0,
    fallback: true,
  };
}

export async function POST(request: NextRequest) {
  const rateLimited = await heavyLimiter.checkDistributed(request);
  if (rateLimited) return rateLimited;

  let body: { scenario?: string; statement?: Record<string, unknown>; witness?: Record<string, unknown> } = {};
  
  try {
    body = await request.json();
    const { scenario, statement, witness } = body;

    // Validate required fields
    if (!statement || Object.keys(statement).length === 0) {
      logger.error('[ZK Generate] Missing or empty statement in request');
      return NextResponse.json({
        success: false,
        error: 'Statement is required and cannot be empty'
      }, { status: 400 });
    }

    if (!witness || Object.keys(witness).length === 0) {
      logger.error('[ZK Generate] Missing or empty witness in request');
      return NextResponse.json({
        success: false,
        error: 'Witness is required and cannot be empty'
      }, { status: 400 });
    }

    logger.info('[ZK Generate] Received request:', { 
      scenario, 
      statementKeys: Object.keys(statement), 
      witnessKeys: Object.keys(witness),
      zkApiUrl: (process.env.ZK_API_URL || '').trim() ? 'configured' : 'not configured'
    });

    // Prepare data based on scenario type
    let _proofData: Record<string, unknown> = {};
    
    if (scenario === 'portfolio_risk') {
      _proofData = {
        portfolio_risk: witness?.actual_risk_score ?? null,
        portfolio_value: witness?.portfolio_value ?? null,
        threshold: statement?.threshold ?? null
      };
    } else if (scenario === 'settlement_batch') {
      _proofData = {
        transaction_count: (witness?.transactions as unknown[])?.length ?? 5,
        total_amount: witness?.total_amount ?? null,
        batch_id: witness?.batch_id ?? null
      };
    } else if (scenario === 'compliance_check') {
      _proofData = {
        kyc_score: witness?.kyc_score ?? null,
        risk_level: witness?.risk_level ?? null,
        jurisdiction: witness?.jurisdiction ?? null
      };
    } else {
      // Generic data format
      _proofData = { ...(statement || {}), ...(witness || {}) };
    }

    // Call the real FastAPI ZK server
    logger.info(`[ZK Generate] Calling ZK server at ${ZK_API_URL}/api/zk/generate`);
    
    const response = await fetch(`${ZK_API_URL}/api/zk/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        proof_type: 'settlement', // Map all to settlement for now
        data: {
          statement: statement,  // Backend expects statement and witness inside data
          witness: witness
        }
      }),
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[ZK Generate] Server returned ${response.status}: ${errorText}`);
      throw new Error(`ZK API error: ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();
    logger.info('[ZK Generate] Proof generated successfully:', { status: result.status, hasProof: !!result.proof });
    
    // Check if proof generation is complete
    if (result.status === 'pending' || result.job_id) {
      // Poll for completion
      const jobId = result.job_id;
      const maxAttempts = 30;
      logger.info(`[ZK Generate] Polling for job ${jobId} completion...`);
      
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const statusResponse = await fetch(`${ZK_API_URL}/api/zk/proof/${jobId}`);
        if (!statusResponse.ok) {
          logger.error(`[ZK Generate] Failed to check proof status (attempt ${attempt + 1}/${maxAttempts})`);
          throw new Error('Failed to check proof status');
        }
        
        const statusResult = await statusResponse.json();
        logger.debug(`[ZK Generate] Status check ${attempt + 1}/${maxAttempts}: ${statusResult.status}`);
        
        if (statusResult.status === 'completed' && statusResult.proof) {
          logger.info(`[ZK Generate] Proof completed successfully in ${statusResult.duration_ms}ms`);
          return NextResponse.json({
            success: true,
            proof: statusResult.proof,
            claim: statusResult.claim,
            statement: statement,
            scenario: scenario,
            duration_ms: statusResult.duration_ms
          });
        } else if (statusResult.status === 'failed') {
          logger.error('[ZK Generate] Proof generation failed:', undefined, { error: statusResult.error });
          throw new Error(statusResult.error || 'Proof generation failed');
        }
      }
      
      logger.error(`[ZK Generate] Proof generation timeout after ${maxAttempts} attempts`);
      throw new Error('Proof generation timeout');
    }

    logger.info('[ZK Generate] Proof returned immediately');
    return NextResponse.json({
      success: true,
      proof: result.proof,
      claim: result.claim,
      statement: statement,
      scenario: scenario
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[ZK Generate] ZK backend error: ${errorMessage}`, error);
    
    // PRODUCTION SAFETY: Never use fallback proofs in production - real money at stake
    if (ProductionGuard.ENFORCE_PRODUCTION_SAFETY) {
      ProductionGuard.auditLog({
        timestamp: Date.now(),
        operation: 'ZK_BACKEND_UNAVAILABLE',
        result: 'failure',
        reason: errorMessage,
        metadata: {
          scenario: body.scenario,
          statement: body.statement
        }
      });
      
      return NextResponse.json({
        success: false,
        error: 'ZK proof generation service unavailable',
        code: 'ZK_SERVICE_UNAVAILABLE',
        message: 'Zero-knowledge proof backend is currently unavailable. Please try again later.'
      }, { status: 503 });
    }
    
    // Only allow fallback in development/testing
    logger.warn('[ZK Generate] DEV MODE: Falling back to deterministic proof generation');
    
    const fallbackResult = generateFallbackProof(
      body.scenario || 'generic',
      body.statement || {},
      body.witness || {}
    );
    return NextResponse.json(fallbackResult);
  }
}
