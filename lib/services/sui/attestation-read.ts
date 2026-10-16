/**
 * Whether the pool contract is accepting deposits and withdrawals, read from
 * chain. One read for the health endpoint and the pool page, so the two
 * cannot disagree about it.
 */
import { SUI_USDC_POOL_CONFIG } from '@/lib/types/sui-pool-types';
import { createFailoverSuiClient } from '@/lib/services/sui/sui-failover-transport';
import { attestationStatus, type AttestationStatus } from '@/lib/services/sui/attestation-status';

export interface PoolAttestation extends AttestationStatus {
  /** The wallet that signs the attestations; its gas is what keeps them coming. */
  treasury?: string;
}

/**
 * Null when no pool is configured on this network. Throws when the chain
 * cannot be read: an unknown state must not read as "accepting deposits".
 */
export async function readPoolAttestation(network: 'mainnet' | 'testnet', nowMs: number = Date.now()): Promise<PoolAttestation | null> {
  const poolStateId = SUI_USDC_POOL_CONFIG[network].poolStateId;
  if (!poolStateId) return null;
  const client = createFailoverSuiClient(network);
  const field = async (key: string): Promise<unknown> => {
    const res = await client.getDynamicFieldObject({ parentId: poolStateId, name: { type: 'vector<u8>', value: Array.from(Buffer.from(key)) } });
    if (res.error) {
      if (res.error.code === 'dynamicFieldNotFound') return undefined;
      throw new Error(`${key}: ${res.error.code}`);
    }
    return (res.data?.content as { fields?: { value?: unknown } } | undefined)?.fields?.value;
  };
  const [required, ts, pool] = await Promise.all([
    field('external_nav_required'),
    field('external_nav_ts_ms'),
    client.getObject({ id: poolStateId, options: { showContent: true } }),
  ]);
  const status = attestationStatus({ required: required === true, tsMs: ts === undefined ? undefined : Number(ts), nowMs });
  const treasury = (pool.data?.content as { fields?: { treasury?: string } } | undefined)?.fields?.treasury;
  return { ...status, ...(treasury ? { treasury } : {}) };
}
