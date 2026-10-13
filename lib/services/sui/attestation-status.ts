/**
 * What the pool contract's NAV attestation means for users, and how long the
 * signer's gas will keep it alive. Pure, so the pool job, the health endpoint
 * and the pool route all judge it the same way.
 *
 * The contract refuses deposits and withdrawals once the attestation is older
 * than EXTERNAL_NAV_MAX_AGE_MS (two hours) while strict mode is on. From
 * 2026-10-06 that happened for six days because the signer was 36,039 MIST
 * short of a budget set at thirteen times the real cost, and nothing but a
 * Discord line said so.
 */

/** `EXTERNAL_NAV_MAX_AGE_MS` in `community_pool_usdc.move`, in minutes. */
export const ATTESTATION_MAX_AGE_MIN = 120;
/** Warn at half the limit: one missed hour is still recoverable without users noticing. */
export const ATTESTATION_WARN_AGE_MIN = 60;

/**
 * Net cost of one attestation. Measured on mainnet 2026-09-30 to 2026-10-06:
 * computation 102,000 + storage 11,970,000 - rebate 11,850,300 = 221,700 MIST,
 * identical on every single-step transaction. Rounded up.
 */
export const ATTEST_NET_COST_MIST = 250_000;
/** Below this many attestations of gas the operator is told; below the second, it is urgent. */
export const GAS_RUNWAY_WARN = 200;
export const GAS_RUNWAY_URGENT = 20;

export interface AttestationStatus {
  status: 'ok' | 'warn' | 'down';
  /** Undefined when the pool has never been attested. */
  ageMin?: number;
  /** True when the contract is refusing deposits and withdrawals right now. */
  blocked: boolean;
}

export function attestationStatus(args: { required: boolean; tsMs: number | undefined; nowMs: number }): AttestationStatus {
  const ageMin = args.tsMs && args.tsMs > 0 ? Math.max(0, (args.nowMs - args.tsMs) / 60_000) : undefined;
  if (!args.required) return { status: 'ok', ageMin, blocked: false };
  if (ageMin === undefined || ageMin > ATTESTATION_MAX_AGE_MIN) return { status: 'down', ageMin, blocked: true };
  if (ageMin > ATTESTATION_WARN_AGE_MIN) return { status: 'warn', ageMin, blocked: false };
  return { status: 'ok', ageMin, blocked: false };
}

/** How many more attestations the signer can pay for. */
export function attestationsLeft(balanceMist: bigint | number | string): number {
  const b = BigInt(balanceMist);
  return b <= 0n ? 0 : Number(b / BigInt(ATTEST_NET_COST_MIST));
}

export function gasRunwayLevel(left: number): 'ok' | 'warn' | 'urgent' {
  return left < GAS_RUNWAY_URGENT ? 'urgent' : left < GAS_RUNWAY_WARN ? 'warn' : 'ok';
}
