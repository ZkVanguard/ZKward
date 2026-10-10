/**
 * Client for the proof server (`zkp/api/server.py`).
 *
 * Asks the server for a bounds ZK-STARK and then checks the answer with the
 * local verifier (`zk/verifier/boundsStark.ts`). `verified` on a result is
 * that check's verdict and nothing else: a proof this process has not
 * verified is never reported as verified.
 *
 * Server only: it sends the private witness to the prover.
 */
import { zkApiHeaders } from '@/lib/utils/zk-api-auth';
import {
  verifyBoundsProof,
  verifyHedgePolicyProof,
  type BoundsStatement,
  type HedgePolicyCaps,
} from '../verifier/boundsStark';

type Int = number | bigint | string;

export interface BoundsWitness {
  /** One private integer per bound of the statement, in order. */
  values: Int[];
  /** Further private integers below 2^62, committed but not constrained. */
  payload?: Int[];
}

export interface HedgePolicyWitness {
  asset: string;
  side: 'LONG' | 'SHORT';
  leverageX: number;
  notionalValueUsdcCents: Int;
  /** Size in thousandths of one asset unit. */
  sizeMilli: Int;
  entryPriceCents: Int;
  portfolioId?: number;
  timestampMs?: number;
}

export interface ZKProof {
  proof: Record<string, unknown>;
  /** 96 hex characters (SHA-384). Commits to the private values; this is what is stored next to a record. */
  commitment: string;
  /** Same value as `commitment`, under the name older callers read. */
  proofHash: string;
  /** The caller's secret: what an auditor needs to read the values back out of the commitment. */
  opening: Record<string, unknown>;
  /** The local verifier's verdict on `proof` for the statement that was asked for. */
  verified: boolean;
  generationTime: number;
  protocol: string;
}

/** The prover answered that the witness is outside the statement: there is nothing to prove. */
export class ProofRefusedError extends Error {}
/** The prover could not be reached, or answered with something that is not a proof. */
export class ProverUnavailableError extends Error {}

const PROVE_TIMEOUT_MS = Number(process.env.ZK_PYTHON_TIMEOUT) || 30_000;

function proverUrl(): string {
  return (process.env.ZK_API_URL || '').trim() || 'http://localhost:8000';
}

/** JSON with integers of any size written as bare numbers, which is what the prover reads. */
function toJson(body: unknown): string {
  return JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? `\u0000int:${v}` : v)).replace(/"\\u0000int:(-?\d+)"/g, '$1');
}

async function callProver(path: string, body: unknown): Promise<{ proof: Record<string, unknown>; commitment: string; opening: Record<string, unknown> }> {
  const payload = toJson(body);
  let res: Response;
  try {
    res = await fetch(`${proverUrl()}${path}`, { method: 'POST', headers: zkApiHeaders(), body: payload, signal: AbortSignal.timeout(PROVE_TIMEOUT_MS) });
  } catch (e) {
    throw new ProverUnavailableError(`prover unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 422) {
    const detail = ((await res.json().catch(() => ({}))) as { detail?: unknown }).detail;
    throw new ProofRefusedError(typeof detail === 'string' ? detail : 'the prover refused the witness');
  }
  if (!res.ok) throw new ProverUnavailableError(`prover answered ${res.status}`);
  const out = (await res.json()) as { proof?: Record<string, unknown>; commitment?: string; opening?: Record<string, unknown> };
  if (!out.proof || typeof out.commitment !== 'string' || !out.opening) throw new ProverUnavailableError('prover answered without a proof');
  return { proof: out.proof, commitment: out.commitment, opening: out.opening };
}

function result(out: Awaited<ReturnType<typeof callProver>>, verified: boolean, startedAt: number): ZKProof {
  return {
    proof: out.proof,
    commitment: out.commitment,
    proofHash: out.commitment,
    opening: out.opening,
    verified,
    generationTime: Date.now() - startedAt,
    protocol: String(out.proof.protocol ?? ''),
  };
}

/** Prove that the witness values are inside the statement's bounds. */
export async function proveBounds(statement: BoundsStatement, witness: BoundsWitness): Promise<ZKProof> {
  const startedAt = Date.now();
  const out = await callProver('/api/zk/bounds/prove', {
    statement: { ...statement, bounds: statement.bounds.map(([lo, hi]) => [BigInt(lo), BigInt(hi)]) },
    witness: { values: witness.values.map((v) => BigInt(v)), payload: (witness.payload ?? []).map((v) => BigInt(v)) },
  });
  return result(out, verifyBoundsProof(out.proof, statement, out.commitment), startedAt);
}

/** Prove that a hedge is inside the caps and that its notional covers size times price. */
export async function proveHedgePolicy(hedge: HedgePolicyWitness, caps: HedgePolicyCaps): Promise<ZKProof> {
  const startedAt = Date.now();
  const big = (v: Int) => BigInt(v);
  const out = await callProver('/api/zk/hedge-policy/prove', {
    witness: { ...hedge, notionalValueUsdcCents: big(hedge.notionalValueUsdcCents), sizeMilli: big(hedge.sizeMilli), entryPriceCents: big(hedge.entryPriceCents) },
    public: { leverage_cap: big(caps.leverage_cap), notional_cap_cents: big(caps.notional_cap_cents), ...(caps.asset_count === undefined ? {} : { asset_count: big(caps.asset_count) }) },
  });
  return result(out, verifyHedgePolicyProof(out.proof, caps, out.commitment), startedAt);
}

/** "The committed risk score is between 0 and `threshold`." */
export function riskScoreStatement(threshold: number): BoundsStatement {
  return { kind: 'risk-score', bounds: [[0, Math.round(threshold)]] };
}

/** A SHA-256 digest as five 52-bit integers, most significant first: the form a proof's payload carries. */
export function hashToLimbs(hex: string): bigint[] {
  const clean = hex.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('expected a 32-byte hex digest');
  const padded = clean.padStart(65, '0');
  return [0, 13, 26, 39, 52].map((at) => BigInt(`0x${padded.slice(at, at + 13)}`));
}

/**
 * Prove that a risk score is at most `threshold`. The digest of the inputs the
 * score was computed from is committed with it, so whoever is given the
 * opening can check which inputs the score belongs to. The proof does not
 * show that the score was computed correctly from them.
 */
export async function proveRiskScore(totalRisk: number, threshold: number, inputsHash: string): Promise<ZKProof> {
  return proveBounds(riskScoreStatement(threshold), { values: [Math.round(totalRisk)], payload: hashToLimbs(inputsHash) });
}
