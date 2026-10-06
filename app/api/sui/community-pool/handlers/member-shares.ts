/**
 * A member's share balance read straight from the pool's members table.
 *
 * Unlike the cached position read used for display, this one never turns a
 * failed read into "not a member": it throws, so a caller that gates an
 * action on ownership refuses with "try again" instead of "you own nothing".
 */
import type { NetworkType } from './types';

const SHARE_SCALE = 1_000_000;

export async function readMemberSharesStrict(network: NetworkType, wallet: string): Promise<number> {
  const { getSuiUsdcPoolService } = await import('@/lib/services/sui/SuiCommunityPoolService');
  const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');

  const poolStateId = await getSuiUsdcPoolService(network).getPoolStateId();
  if (!poolStateId) throw new Error('pool state id is not available');

  const client = createFailoverSuiClient(network);
  const pool = await client.getObject({ id: poolStateId, options: { showContent: true } });
  const poolFields = (pool.data?.content as { fields?: Record<string, any> } | null | undefined)?.fields;
  const membersTableId = poolFields?.members?.fields?.id?.id;
  if (typeof membersTableId !== 'string') throw new Error('members table id could not be read');

  const res = await client.getDynamicFieldObject({
    parentId: membersTableId,
    name: { type: 'address', value: wallet },
  });
  if (res.error) {
    if (res.error.code === 'dynamicFieldNotFound') return 0;
    throw new Error(`member read failed: ${res.error.code}`);
  }
  const content = res.data?.content as { fields?: Record<string, any> } | null | undefined;
  const member = content?.fields?.value?.fields ?? content?.fields;
  if (!member || member.shares === undefined) throw new Error('member record has no shares field');

  const raw = Number(member.shares);
  if (!Number.isFinite(raw) || raw < 0) throw new Error('member shares are not a number');
  return raw / SHARE_SCALE;
}
