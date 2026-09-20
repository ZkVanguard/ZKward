'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Loader2, Minus, ExternalLink } from 'lucide-react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { useSuiSafe } from '@/app/sui-providers';

const OLD_PACKAGE = '0x900bca6461ad24c86b83c974788b457cb76c3f6f4fd7b061c5b58cb40d974bab';
const OLD_POOL = '0xf7127c7d55131847b702481deb2ebee0c81150f9738d5f679cd7b1a998e620d8';
const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

interface OldPoolInfo {
  balance: number;
  hedged: number;
  totalShares: number;
  memberShares: number;
  memberAddress: string | null;
}

export function OldPoolWithdraw() {
  const account = useCurrentAccount();
  const sui = useSuiSafe();

  const [poolInfo, setPoolInfo] = useState<OldPoolInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [poolDrained, setPoolDrained] = useState(false);

  const walletAddress = account?.address ?? null;

  // Fetch old pool state
  const fetchOldPool = useCallback(async () => {
    setLoading(true);
    try {
      const rpc = await fetch('/api/rpc/sui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'sui_getObject',
          params: [OLD_POOL, { showContent: true }],
        }),
      });
      const obj = await rpc.json();
      const fields = obj.result?.data?.content?.fields;
      if (!fields) {
        setPoolDrained(true);
        return;
      }

      const balance = Number(fields.balance || 0) / 1e6;
      // Note: total_hedged_value is stale (UpgradeCap lost, can't reset on-chain).
      // It does NOT affect withdrawals. Calculate_assets_for_shares uses balance only.
      const hedged = 0;
      const totalShares = Number(fields.total_shares || 0) / 1e6;

      if (balance <= 0 && totalShares <= 0) {
        setPoolDrained(true);
        return;
      }

      // Check if connected wallet is a member
      let memberShares = 0;
      let memberAddress: string | null = null;
      if (walletAddress && fields.members?.fields?.id?.id) {
        const membersTableId = fields.members.fields.id.id;
        const memberRpc = await fetch('/api/rpc/sui', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 2,
            method: 'suix_getDynamicFieldObject',
            params: [membersTableId, { type: 'address', value: walletAddress }],
          }),
        });
        const memberObj = await memberRpc.json();
        const mFields = memberObj.result?.data?.content?.fields?.value?.fields;
        if (mFields) {
          memberShares = Number(mFields.shares || 0) / 1e6;
          memberAddress = walletAddress;
        }
      }

      setPoolInfo({ balance, hedged, totalShares, memberShares, memberAddress });
    } catch {
      setError('Failed to fetch old pool data');
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    fetchOldPool();
  }, [fetchOldPool]);

  const handleWithdraw = async () => {
    if (!poolInfo || !walletAddress || poolInfo.memberShares <= 0) return;
    if (!sui) {
      setError('SUI wallet context not available');
      return;
    }

    setWithdrawing(true);
    setError(null);
    setSuccess(null);

    try {
      // Calculate max safe shares (balance-based, not NAV-based since contract uses balance)
      const balanceRaw = Math.floor(poolInfo.balance * 1e6);
      const totalSharesRaw = Math.floor(poolInfo.totalShares * 1e6);
      const memberSharesRaw = Math.floor(poolInfo.memberShares * 1e6);
      const VIRTUAL_ASSETS = 1_000_000;
      const VIRTUAL_SHARES = 1_000_000;

      const totalAssets = balanceRaw + VIRTUAL_ASSETS;
      const totalSharesWithVirtual = totalSharesRaw + VIRTUAL_SHARES;

      // Max shares such that withdrawal amount <= balance
      const maxSafeShares = Math.floor(
        (balanceRaw * totalSharesWithVirtual) / totalAssets
      );
      const sharesToBurn = Math.min(memberSharesRaw, maxSafeShares);

      if (sharesToBurn <= 0) {
        setError('No withdrawable balance (funds may be hedged)');
        setWithdrawing(false);
        return;
      }

      const estimatedUsdc = (sharesToBurn * totalAssets) / totalSharesWithVirtual / 1e6;

      const { Transaction } = await import('@mysten/sui/transactions');
      const tx = new Transaction();
      tx.moveCall({
        target: `${OLD_PACKAGE}::community_pool_usdc::withdraw`,
        typeArguments: [USDC_TYPE],
        arguments: [
          tx.object(OLD_POOL),
          tx.pure.u64(sharesToBurn),
          tx.object('0x6'),
        ],
      });

      // Check if wallet has SUI for gas — if not, use admin-sponsored execution
      const gasRes = await fetch('/api/rpc/sui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'suix_getBalance',
          params: [walletAddress, '0x2::sui::SUI'],
        }),
      });
      const gasData = await gasRes.json();
      const suiGasBalance = BigInt(gasData.result?.totalBalance || '0');
      const needsSponsoring = suiGasBalance < BigInt(10_000_000); // < 0.01 SUI

      let result: { digest: string; success: boolean; error?: string };

      if (needsSponsoring) {
        // Use admin-sponsored gas (admin wallet pays for gas)
        result = await sui.sponsoredExecute(tx);
      } else {
        // User has gas, use normal execute
        result = await sui.executeTransaction(tx);
      }

      if (!result.success) {
        setError(result.error || 'Transaction failed. Please try again.');
        setWithdrawing(false);
        return;
      }

      setSuccess(`Withdrew ~$${estimatedUsdc.toFixed(2)} USDC! TX: ${result.digest.slice(0, 16)}...`);
      // Refresh pool state
      setTimeout(() => fetchOldPool(), 3000);
    } catch (err: any) {
      setError(err.message || 'Withdrawal failed');
    } finally {
      setWithdrawing(false);
    }
  };

  // Don't render if pool is empty/drained
  if (poolDrained) return null;

  // Don't render while loading initial state
  if (loading && !poolInfo) return null;

  // Don't show if no balance
  if (poolInfo && poolInfo.balance <= 0) return null;

  return (
    <div className="mt-4 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 rounded-lg p-4 border border-amber-200 dark:border-amber-700">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-4 h-4 text-amber-500" />
        <h4 className="font-semibold text-gray-900 dark:text-white text-sm">Old Pool Recovery</h4>
        <span className="px-2 py-0.5 text-xs bg-amber-500 text-white rounded-full">Legacy</span>
        <a
          href={`https://suiscan.xyz/mainnet/object/${OLD_POOL}`}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-xs text-amber-600 dark:text-amber-400 hover:underline"
        >
          <ExternalLink className="w-3 h-3" />
          View
        </a>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
        <div className="bg-white/60 dark:bg-gray-800/60 rounded p-2">
          <span className="text-gray-500 dark:text-gray-400">Balance</span>
          <p className="font-medium text-gray-900 dark:text-white">${poolInfo?.balance.toFixed(2) ?? '...'}</p>
        </div>
        <div className="bg-white/60 dark:bg-gray-800/60 rounded p-2">
          <span className="text-gray-500 dark:text-gray-400">Your Shares</span>
          <p className="font-medium text-gray-900 dark:text-white">{poolInfo?.memberShares.toFixed(2) ?? '0'}</p>
        </div>
      </div>

      {!walletAddress ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Connect your SUI wallet to check if you have funds in the old pool.
        </p>
      ) : poolInfo && poolInfo.memberShares > 0 ? (
        <button
          onClick={handleWithdraw}
          disabled={withdrawing || poolInfo.balance <= 0}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm"
        >
          {withdrawing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Minus className="w-4 h-4" />
          )}
          {withdrawing ? 'Withdrawing...' : `Withdraw ~$${Math.min(poolInfo.balance, poolInfo.memberShares).toFixed(2)} USDC`}
        </button>
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Your connected wallet ({walletAddress.slice(0, 8)}...{walletAddress.slice(-6)}) has no shares in the old pool.
          The depositor was 0x880c...8aac.
        </p>
      )}

      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
      {success && (
        <p className="mt-2 text-xs text-green-600 dark:text-green-400">{success}</p>
      )}
    </div>
  );
}
