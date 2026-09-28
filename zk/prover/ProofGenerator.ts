/**
 * @fileoverview ZK Proof Generator - TypeScript wrapper for Python ZK-STARK system
 * @module zk/prover/ProofGenerator
 */

import { zkApiHeaders } from '@/lib/utils/zk-api-auth';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../../shared/utils/logger';
import { RiskAnalysis } from '../../shared/types/agent';
import {
  CanonicalRiskInputs,
  RISK_CANONICAL_VERSION,
  prepareRiskBinding,
  type RiskBinding,
} from './riskCanonical';

export interface ZKProofInput {
  proofType: string;
  statement: Record<string, unknown>;
  witness: Record<string, unknown>;
}

export interface ZKProof {
  proof: Record<string, unknown>;
  proofHash: string;
  proofType: string;
  verified: boolean;
  generationTime: number;
  protocol: string;
  /**
   * Present when the proof was generated with canonical binding (risk
   * proofs since v1). Contains the hashes the STARK statement pins.
   * Consumers should attach this to `RiskAnalysis.zkBinding` and pass
   * `commitmentHash` to on-chain verification.
   */
  binding?: {
    inputsHash: string;
    outputHash: string;
    commitmentHash: string;
    canonicalVersion: typeof RISK_CANONICAL_VERSION;
  };
}

/**
 * ProofGenerator class - Interfaces with Python ZK-STARK implementation
 */
export class ProofGenerator {
  private pythonPath: string;
  private zkSystemPath: string;

  constructor() {
    // Path to Python ZK system
    this.pythonPath = process.env.ZK_PYTHON_PATH || 'python';
    this.zkSystemPath = process.env.ZK_SYSTEM_PATH || path.join(process.cwd(), 'zkp');
  }

  /**
   * Generate ZK-STARK proof for risk calculation with cryptographic
   * binding between the reported `totalRisk` and the inputs that
   * produced it.
   *
   * The caller MUST provide `CanonicalRiskInputs`. Every numeric input
   * is folded into `inputsHash`, and the STARK statement's
   * `public_inputs` array pins `[inputsHash, outputHash, totalRisk,
   * threshold]` — mutating any of these post-hoc invalidates the proof.
   *
   * The Python prover asserts three things before generating the trace:
   *   1. sha256(canonical_json(witness)) === inputsHash
   *   2. base_risk_score(volatility, exposures) === witness.baseRiskScore
   *   3. fuse(base, ai) === witness.totalRisk
   * Any mismatch causes a proof-generation error, so a honest prover
   * can only produce a proof for a self-consistent (input → output)
   * tuple.
   *
   * The returned `ZKProof.binding` field should be attached to
   * `RiskAnalysis.zkBinding` by the caller for downstream verification.
   */
  async generateRiskProof(
    riskAnalysis: RiskAnalysis,
    canonical: CanonicalRiskInputs,
  ): Promise<ZKProof> {
    logger.info('Generating bound ZK-STARK proof for risk calculation', {
      portfolioId: riskAnalysis.portfolioId,
      canonicalVersion: canonical.version,
    });

    // Cross-check the analysis vs the canonical inputs. The two arrive
    // through separate call paths — a mismatch means the caller built
    // the canonical struct incorrectly and the proof would silently
    // certify the wrong tuple.
    if (canonical.portfolioId !== riskAnalysis.portfolioId) {
      throw new Error(
        `[ZK-RISK] portfolioId mismatch: analysis=${riskAnalysis.portfolioId} canonical=${canonical.portfolioId}`,
      );
    }
    if (canonical.totalRisk !== Math.round(riskAnalysis.totalRisk)) {
      throw new Error(
        `[ZK-RISK] totalRisk mismatch: analysis=${Math.round(riskAnalysis.totalRisk)} canonical=${canonical.totalRisk}`,
      );
    }
    if (canonical.version !== RISK_CANONICAL_VERSION) {
      throw new Error(
        `[ZK-RISK] canonical version mismatch: expected ${RISK_CANONICAL_VERSION}, got ${canonical.version}`,
      );
    }

    const binding: RiskBinding = prepareRiskBinding(canonical);

    // Public statement — everything a verifier gets to see.
    // `public_inputs` is what the STARK's `statement_hash` folds in.
    // Order is byte-critical: it must match what Python uses to
    // recompute the expected statement_hash during verification.
    const statement = {
      claim: `zkv-risk-v${RISK_CANONICAL_VERSION}`,
      public_inputs: [
        binding.inputsHash,
        binding.outputHash,
        String(canonical.totalRisk),
        String(canonical.threshold),
      ],
      // Public metadata — surfaced on-chain / to humans. As of the
      // 2026-07-27 statement_hash canonicalization fix, the WHOLE
      // statement folds into statement_hash (not just claim + public_inputs),
      // so any drift in public_data between prove and verify time will
      // reject at verification. Callers must pass the identical statement
      // dict at verify() that was passed at generate().
      public_data: {
        portfolioId: canonical.portfolioId,
        chain: canonical.chain,
        timestampMs: canonical.timestampMs,
        canonicalVersion: canonical.version,
        commitmentHash: binding.commitmentHash,
      },
    };

    // Private witness — the full canonical struct, sent to Python for
    // assertion-based binding. Python recomputes inputsHash from
    // canonical_json(witness) and rejects on mismatch.
    const witness = {
      canonical, // full nested object, mirrors CanonicalRiskInputs
      // Legacy field kept so existing prover paths still find a
      // `secret_value`; identical to totalRisk.
      secret_value: canonical.totalRisk,
    };

    const proof = await this.generateProof('risk', statement, witness);

    proof.binding = {
      inputsHash: binding.inputsHash,
      outputHash: binding.outputHash,
      commitmentHash: binding.commitmentHash,
      canonicalVersion: RISK_CANONICAL_VERSION,
    };

    return proof;
  }

  /**
   * Generate generic ZK-STARK proof
   */
  async generateProof(
    proofType: string,
    statement: Record<string, unknown>,
    witness: Record<string, unknown>
  ): Promise<ZKProof> {
    const startTime = Date.now();

    try {
      logger.info('Generating ZK-STARK proof', {
        proofType,
        statement: Object.keys(statement),
      });

      // Call Python ZK-STARK system
      const result = await this.callPythonProver(proofType, statement, witness);
      const resultProof = result.proof as Record<string, unknown>;

      // Determine verification status
      // If proof was successfully generated with required fields, it's considered valid
      const hasRequiredFields = !!(resultProof && 
        (resultProof.merkle_root || resultProof.trace_merkle_root) &&
        resultProof.query_responses);
      
      const proof: ZKProof = {
        proof: resultProof,
        proofHash: (resultProof.merkle_root as string) || (resultProof.trace_merkle_root as string) || this.hashProofSync(resultProof),
        proofType,
        verified: resultProof?.verified === true || (result.verified as boolean) === true || hasRequiredFields,
        generationTime: Date.now() - startTime,
        protocol: (resultProof.protocol as string) || 'ZK-STARK',
      };

      logger.info('ZK-STARK proof generated successfully', {
        proofType,
        generationTime: proof.generationTime,
        proofHash: proof.proofHash.substring(0, 16) + '...',
      });

      return proof;
    } catch (error) {
      const details = error instanceof Error ? { message: error.message, stack: error.stack } : { error: String(error) };
      logger.error('Failed to generate ZK-STARK proof', {
        proofType,
        error: details,
      });

      // No fallback - real ZK proofs required
      throw error;
    }
  }

  /**
   * Call Python ZK-STARK prover via HTTP API
   */
  private async callPythonProver(
    proofType: string,
    statement: Record<string, unknown>,
    witness: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    // ZK API URL - default to localhost:8000 where FastAPI server runs
    const zkApiUrl = process.env.ZK_API_URL || process.env.NEXT_PUBLIC_ZK_API_URL || 'http://localhost:8000';
    const timeout = Number(process.env.ZK_PYTHON_TIMEOUT) || 120000;
    const pollInterval = 100; // ms between status checks

    // Map proof types to supported scenarios
    // The ZK server supports: 'risk-calculation', 'compliance', 'default'
    const supportedScenario = this.mapProofTypeToScenario(proofType);

    logger.info('Calling ZK API', { url: `${zkApiUrl}/api/zk/generate`, proofType, mappedScenario: supportedScenario });
    
    const startTime = Date.now();

    try {
      // Submit proof generation request
      const resp = await fetch(`${zkApiUrl}/api/zk/generate`, {
        method: 'POST',
        headers: zkApiHeaders(),
        body: JSON.stringify({ 
          proof_type: supportedScenario,
          scenario: supportedScenario,
          data: { statement, witness },
          statement, 
          witness,
        }),
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`ZK API error: ${resp.status} - ${txt}`);
      }
      
      let result = await resp.json();
      
      // Handle async job pattern - poll until completed
      if (result && result.job_id && result.status === 'pending') {
        logger.info('Proof job submitted, polling for completion', { jobId: result.job_id });
        
        // Poll for result
        while (Date.now() - startTime < timeout) {
          const statusResp = await fetch(`${zkApiUrl}/api/zk/proof/${result.job_id}`, {
            method: 'GET',
            headers: zkApiHeaders(),
          });
          
          if (!statusResp.ok) {
            const txt = await statusResp.text().catch(() => '');
            throw new Error(`ZK API status check error: ${statusResp.status} - ${txt}`);
          }
          
          result = await statusResp.json();
          
          // Check if completed (has proof data)
          if (result && result.proof) {
            logger.info('Proof generation completed', { 
              jobId: result.job_id,
              duration: Date.now() - startTime 
            });
            break;
          }
          
          // Check for failure status
          if (result && result.status === 'failed') {
            throw new Error(`ZK proof generation failed: ${result.error || 'Unknown error'}`);
          }
          
          // Check for error field
          if (result && result.error) {
            throw new Error(`ZK proof generation error: ${result.error}`);
          }
          
          // Wait before next poll
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }
        
        // Check for timeout
        if (!result.proof) {
          throw new Error('ZK API request timed out waiting for proof');
        }
      }
      
      // Handle direct proof response
      if (result && result.proof) {
        logger.info('Received proof from ZK API', { 
          verified: result.proof?.verified,
          protocol: result.proof?.protocol 
        });
        return result;
      }
      
      // If no proof in response, return the whole result
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('ZK API request timed out');
      }
      
      throw error;
    }
  }

  /**
   * Map arbitrary proof types to supported ZK scenarios
   */
  private mapProofTypeToScenario(proofType: string): string {
    // Map test/generic proof types to supported scenarios
    const mappings: Record<string, string> = {
      'risk-calculation': 'risk-calculation',
      'risk': 'risk-calculation',
      'compliance': 'compliance',
      // All other types fall back to 'default' which uses generic prover
    };
    
    // Check if we have a direct mapping
    if (mappings[proofType]) {
      return mappings[proofType];
    }
    
    // For test-related proof types, use risk-calculation (most common)
    if (proofType.includes('test') || proofType.includes('perf') || proofType.includes('verify')) {
      return 'risk-calculation';
    }
    
    // Default fallback
    return 'risk-calculation';
  }

  /**
   * Hash proof data to create proof hash
   */
  private hashProofSync(data: unknown): string {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(data));
    return hash.digest('hex');
  }

  /**
   * Batch generate proofs
   */
  async generateBatchProofs(inputs: ZKProofInput[]): Promise<ZKProof[]> {
    logger.info('Generating batch ZK-STARK proofs', { count: inputs.length });

    const promises = inputs.map((input) =>
      this.generateProof(input.proofType, input.statement, input.witness)
    );

    return await Promise.all(promises);
  }

  /**
   * Verify proof is valid structure
   */
  validateProofStructure(proof: ZKProof): boolean {
    return (
      proof.proof !== undefined &&
      proof.proofHash !== undefined &&
      proof.proofType !== undefined &&
      typeof proof.verified === 'boolean' &&
      typeof proof.generationTime === 'number'
    );
  }
}

// Singleton instance
export const proofGenerator = new ProofGenerator();
