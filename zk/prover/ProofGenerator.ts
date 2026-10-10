/**
 * Proofs for the application: make a bounds ZK-STARK in this process, then
 * check it with the verifier (`zk/verifier/boundsStark.ts`). `verified` on a
 * result is that check's verdict and nothing else: a proof this process has
 * not verified is never reported as verified.
 *
 * Server only: it handles the private witness. A proof is a few seconds of
 * CPU, so one is made at a time per instance; callers wait their turn.
 */
import { proveBoundsLocally, WitnessError, type BoundsWitness } from './boundsProver';
import { ASSET_CODE, SIDE_CODE } from './hedgeCanonical';
import {
  hedgePolicyStatement,
  starkInternals,
  verifyBoundsProof,
  type BoundsStatement,
  type HedgePolicyCaps,
} from '../verifier/boundsStark';

export type { BoundsWitness };

type Int = number | bigint | string;

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
  /** The verifier's verdict on `proof` for the statement that was asked for. */
  verified: boolean;
  generationTime: number;
  protocol: string;
}

/** The witness is outside the statement, or the request is malformed: there is nothing to prove. */
export class ProofRefusedError extends Error {}

/** What the proof system is, for health and status surfaces. */
export function proofSystemInfo() {
  return {
    prover: 'bounds-stark',
    protocol: starkInternals.PROTOCOL,
    field: 'Goldilocks, challenges in its quintic extension',
    hash: 'SHA-384',
    trace_rows: starkInternals.N,
    blowup: starkInternals.M / starkInternals.N,
    queries: starkInternals.NUM_QUERIES,
    grinding_bits: starkInternals.GRINDING_BITS,
    trusted_setup: false,
    in_process: true,
  };
}

let queue: Promise<unknown> = Promise.resolve();

/** Prove that the witness values are inside the statement's bounds. */
export function proveBounds(statement: BoundsStatement, witness: BoundsWitness): Promise<ZKProof> {
  const run = async (): Promise<ZKProof> => {
    const startedAt = Date.now();
    let made;
    try {
      made = await proveBoundsLocally(statement, witness);
    } catch (e) {
      if (e instanceof WitnessError) throw new ProofRefusedError(e.message);
      throw e;
    }
    return {
      proof: made.proof,
      commitment: made.commitment,
      proofHash: made.commitment,
      opening: made.opening,
      verified: verifyBoundsProof(made.proof, statement, made.commitment),
      generationTime: Date.now() - startedAt,
      protocol: starkInternals.PROTOCOL,
    };
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** Prove that a hedge is inside the caps and that its notional covers size times price. */
export async function proveHedgePolicy(hedge: HedgePolicyWitness, caps: HedgePolicyCaps): Promise<ZKProof> {
  let statement: BoundsStatement;
  let witness: BoundsWitness;
  try {
    statement = hedgePolicyStatement(caps);
    const asset = ASSET_CODE[String(hedge.asset).toUpperCase() as keyof typeof ASSET_CODE];
    const side = SIDE_CODE[String(hedge.side).toUpperCase() as keyof typeof SIDE_CODE];
    if (asset === undefined || side === undefined) throw new Error('unsupported asset or side');
    if (!Number.isSafeInteger(hedge.leverageX)) throw new Error('leverage is not an integer');
    const notional = BigInt(hedge.notionalValueUsdcCents);
    const size = BigInt(hedge.sizeMilli);
    const price = BigInt(hedge.entryPriceCents);
    // What the notional exceeds the exposure by. A notional that understates the exposure makes this
    // negative, which is outside its bounds: no proof can carry it.
    const slack = starkInternals.PROD_SCALE * notional - size * price;
    witness = {
      values: [hedge.leverageX, notional, asset, side, size, price, slack],
      payload: [hedge.portfolioId ?? 0, hedge.timestampMs ?? 0],
    };
  } catch (e) {
    throw new ProofRefusedError(e instanceof Error ? e.message : 'malformed hedge or caps');
  }
  return proveBounds(statement, witness);
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
