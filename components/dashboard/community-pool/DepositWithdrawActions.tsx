'use client';

import React, { memo, useMemo } from 'react';
import { Plus, Minus, Wallet, ExternalLink, Loader2, AlertTriangle } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import type { PoolSummary, UserPosition, ChainKey, TxStatus } from './types';
import { getDepositTokenInfo } from '@/lib/contracts/community-pool-config';
import { OldPoolWithdraw } from './OldPoolWithdraw';

interface DepositWithdrawActionsProps {
  selectedChain: ChainKey;
  poolData: PoolSummary;
  userPosition: UserPosition | null;
  chainConfig: any;
  poolDeployed: boolean;
  communityPoolAddress: string;
  suiPoolStateId: string | null;
  network: 'mainnet' | 'testnet';
  isFirstDeposit?: boolean;
  isChainMismatch?: boolean;
  userUsdtBalance?: number;
  // EVM state
  showDeposit: boolean;
  showWithdraw: boolean;
  depositAmount: string;
  withdrawShares: string;
  actionLoading: boolean;
  isPending: boolean;
  isConfirming: boolean;
  txStatus: TxStatus;
  address: string | undefined;
  // Wallet type
  activeWalletType?: 'evm' | 'sui' | null;
  // SUI state
  suiIsConnected: boolean;
  suiAddress: string | null;
  suiBalance: string;
  suiDepositAmount: string;
  suiWithdrawShares: string;
  suiNetwork: string;
  suiIsWrongNetwork: boolean;
  // Handlers
  onShowDeposit: (show: boolean) => void;
  onShowWithdraw: (show: boolean) => void;
  onDepositAmountChange: (value: string) => void;
  onWithdrawSharesChange: (value: string) => void;
  onSuiDepositAmountChange: (value: string) => void;
  onSuiWithdrawSharesChange: (value: string) => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onSuiDeposit: () => void;
  onSuiWithdraw: () => void;
}

export const DepositWithdrawActions = memo(function DepositWithdrawActions({
  selectedChain,
  poolData,
  userPosition,
  chainConfig,
  communityPoolAddress,
  suiPoolStateId,
  network = 'testnet',
  isFirstDeposit = false,
  isChainMismatch = false,
  userUsdtBalance = 0,
  showDeposit,
  showWithdraw,
  depositAmount,
  withdrawShares,
  actionLoading,
  isPending,
  isConfirming,
  txStatus,
  address,
  suiIsConnected,
  suiAddress,
  suiDepositAmount,
  suiWithdrawShares,
  suiNetwork,
  suiIsWrongNetwork,
  onShowDeposit,
  onShowWithdraw,
  onDepositAmountChange,
  onWithdrawSharesChange,
  onSuiDepositAmountChange,
  onSuiWithdrawSharesChange,
  onDeposit,
  onWithdraw,
  onSuiDeposit,
  onSuiWithdraw,
}: DepositWithdrawActionsProps) {
  const isSui = selectedChain === 'sui';
  const minDeposit = isFirstDeposit ? 100 : 10;

  // User connects via WDK self-custodial wallet
  const effectiveAddress = address;
  const evmConnected = !!effectiveAddress;

  // Get deposit token info based on chain and network (USDT for mainnet, USDC for testnet)
  const tokenInfo = useMemo(() =>
    getDepositTokenInfo(selectedChain, network),
    [selectedChain, network]
  );

  // Guard: chains where the deposit token contract isn't deployed yet
  // (Hedera testnet currently has usdt = 0x0000...). Rendering the full
  // deposit UI would show a broken 'You have no USDT' warning and let
  // users click Deposit into a doomed approval flow. Render an inline
  // "coming soon" card instead so the pool is still viewable.
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const tokenNotDeployed = !isSui && (!communityPoolAddress
    || communityPoolAddress === ZERO_ADDR
    || (chainConfig?.contracts?.testnet?.usdt === ZERO_ADDR
        && chainConfig?.contracts?.mainnet?.usdt === ZERO_ADDR));

  if (!isSui && tokenNotDeployed) {
    const chainName = chainConfig?.name ?? selectedChain;
    return (
      <div className="p-4 border-b border-gray-100 dark:border-gray-700 min-w-0">
        <div className="flex items-start gap-3 p-4 rounded-xl bg-[#00A79F]/10 border border-[#00A79F]/30 min-w-0">
          <span className="text-2xl flex-shrink-0">🚧</span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-label-primary mb-1">
              Deposits coming to {chainName}
            </div>
            <div className="text-[12px] text-label-secondary leading-relaxed">
              The {chainName} pool contract is live at{' '}
              <code className="font-mono text-[11px] break-all">{communityPoolAddress}</code>{' '}
              — deposit token ({tokenInfo.symbol}) not yet deployed on this network.
              Switch to <strong>SUI</strong> above to deposit USDC into the live pool now,
              or watch this space.
            </div>
          </div>
        </div>
      </div>
    );
  }


  if (isSui) {
    return (
      <div className="p-3 sm:p-4 border-b border-gray-100 dark:border-gray-700 min-w-0">
        <div className="space-y-3 sm:space-y-4">
          {/* SUI Pool Header — stacks on mobile so long badges/link don't burst */}
          <div className="bg-gradient-to-r from-cyan-50 to-blue-50 dark:from-cyan-900/20 dark:to-blue-900/20 rounded-xl sm:rounded-lg p-3 sm:p-4 min-w-0">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <span className="text-xl sm:text-2xl flex-shrink-0">💵</span>
                <h4 className="font-semibold text-gray-900 dark:text-white text-sm sm:text-base truncate">SUI USDC Pool</h4>
                <span className="px-2 py-0.5 text-[10px] sm:text-xs bg-cyan-500 text-white rounded-full flex-shrink-0 whitespace-nowrap">USDC → 3-Asset AI</span>
              </div>
              <a
                href={`${chainConfig?.blockExplorer?.[network] || `https://suiscan.xyz/${network}`}/object/${suiPoolStateId || communityPoolAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] sm:text-xs text-cyan-600 dark:text-cyan-400 hover:underline self-start sm:self-auto flex-shrink-0"
              >
                <ExternalLink className="w-3 h-3" />
                View Pool
              </a>
            </div>

            {suiIsConnected ? (
              // Wrap once past mobile width; long address + share-price string
              // used to bust the row after data loaded.
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] sm:text-sm text-gray-600 dark:text-gray-300 min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Wallet className="w-4 h-4 text-green-500 flex-shrink-0" />
                  <span className="truncate tabular-nums">Connected: {suiAddress?.slice(0, 6)}...{suiAddress?.slice(-4)}</span>
                </div>
                <span className="text-gray-400 hidden sm:inline">|</span>
                <span className="tabular-nums text-[12px] sm:text-sm w-full sm:w-auto text-gray-500 sm:text-inherit">
                  1 share = ${(Number(poolData?.sharePrice) || 1).toFixed(4)} USDC
                </span>
              </div>
            ) : (
              <p className="text-[13px] sm:text-sm text-amber-600 dark:text-amber-400 leading-relaxed">
                Connect a SUI wallet to deposit USDC and earn from AI-managed 3-asset allocation.
              </p>
            )}
          </div>

          {/* Wrong Network Warning */}
          {suiIsConnected && suiIsWrongNetwork && (
            <div className="p-3 sm:p-4 bg-amber-50 dark:bg-amber-900/20 rounded-xl sm:rounded-lg border border-amber-200 dark:border-amber-700 min-w-0">
              <div className="flex items-start sm:items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5 sm:mt-0" />
                <span className="text-[13px] sm:text-sm font-medium text-amber-700 dark:text-amber-400 break-words min-w-0">
                  Wrong Network: Your wallet is on {suiNetwork}
                </span>
              </div>
              <p className="text-[11px] sm:text-xs text-amber-600 dark:text-amber-500 mb-2 leading-relaxed">
                SUI wallets require manual network switching. Please open your wallet extension
                and switch to <strong>{network === 'mainnet' ? 'Mainnet' : 'Testnet'}</strong> in Settings → Network.
              </p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] sm:text-xs text-gray-500 dark:text-gray-400">
                <span>Supported wallets: Sui Wallet, Suiet, Ethos</span>
                <span className="text-amber-500 hidden sm:inline">•</span>
                <span>The app will detect when you switch</span>
              </div>
            </div>
          )}

          {/* SUI Deposit/Withdraw Buttons. 44px tap targets on mobile */}
          <div className="flex gap-2 sm:gap-3">
            <button
              onClick={() => { onShowDeposit(!showDeposit); }}
              disabled={!suiIsConnected || actionLoading || suiIsWrongNetwork}
              className="flex-1 min-w-0 flex items-center justify-center gap-2 h-11 sm:h-auto px-3 sm:px-4 py-2 text-sm sm:text-base bg-green-600 hover:bg-green-700 active:scale-[0.98] disabled:bg-gray-400 disabled:cursor-not-allowed text-white rounded-xl sm:rounded-lg transition-all"
            >
              <Plus className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">Deposit USDC</span>
            </button>
            <button
              onClick={() => { onShowWithdraw(!showWithdraw); }}
              disabled={!suiIsConnected || !userPosition?.isMember || actionLoading || suiIsWrongNetwork}
              className="flex-1 min-w-0 flex items-center justify-center gap-2 h-11 sm:h-auto px-3 sm:px-4 py-2 text-sm sm:text-base bg-red-600 hover:bg-red-700 active:scale-[0.98] disabled:bg-gray-400 disabled:cursor-not-allowed text-white rounded-xl sm:rounded-lg transition-all"
            >
              <Minus className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">Withdraw USDC</span>
            </button>
          </div>

          {/* SUI Deposit Form */}
          <AnimatePresence>
            {showDeposit && suiIsConnected && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
              >
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    step="any"
                    autoComplete="off"
                    value={suiDepositAmount}
                    onChange={(e) => onSuiDepositAmountChange(e.target.value)}
                    placeholder="USDC amount (min $10)"
                    disabled={actionLoading}
                    className="flex-1 min-w-0 h-11 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-50"
                  />
                  <button
                    onClick={onSuiDeposit}
                    disabled={actionLoading || !suiDepositAmount}
                    className="h-11 px-4 py-2 bg-cyan-600 hover:bg-cyan-700 disabled:bg-gray-400 active:scale-[0.98] text-white rounded-lg transition-all flex items-center justify-center gap-2 w-full sm:w-auto flex-shrink-0"
                  >
                    {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                    {txStatus === 'depositing' ? 'Depositing...' : txStatus === 'complete' ? 'Complete!' : 'Deposit'}
                  </button>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  Min deposit: $10 USDC • Your wallet will prompt you to sign the transaction.
                </p>
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                  USDC is deposited on-chain to the pool contract.
                  {' '}Current share price: ${(Number(poolData?.sharePrice) || 1).toFixed(4)} USDC
                  {suiDepositAmount && Number(poolData?.sharePrice) > 0 ? (
                    <> — You&apos;ll receive ~{(parseFloat(suiDepositAmount) / (Number(poolData.sharePrice) || 1)).toFixed(4)} shares</>
                  ) : null}
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* SUI Withdraw Form */}
          <AnimatePresence>
            {showWithdraw && suiIsConnected && userPosition?.isMember && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
              >
                <div className="flex flex-wrap sm:flex-nowrap gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    step="any"
                    autoComplete="off"
                    value={suiWithdrawShares}
                    onChange={(e) => onSuiWithdrawSharesChange(e.target.value)}
                    placeholder={`Shares (max: ${(Number(userPosition?.shares) || 0).toFixed(4)})`}
                    disabled={actionLoading}
                    className="flex-1 basis-full sm:basis-auto min-w-0 h-11 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-50"
                  />
                  <button
                    onClick={() => onSuiWithdrawSharesChange(String(Number(userPosition?.shares) || 0))}
                    disabled={actionLoading}
                    className="h-11 px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 disabled:opacity-50 active:scale-[0.98] rounded-lg text-sm transition-all flex-shrink-0"
                  >
                    Max
                  </button>
                  <button
                    onClick={onSuiWithdraw}
                    disabled={actionLoading || !suiWithdrawShares}
                    className="h-11 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-400 active:scale-[0.98] text-white rounded-lg transition-all flex items-center justify-center gap-2 flex-1 sm:flex-none"
                  >
                    {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Minus className="w-4 h-4" />}
                    {txStatus === 'withdrawing' ? 'Withdrawing...' : txStatus === 'complete' ? 'Complete!' : 'Withdraw'}
                  </button>
                </div>
                {poolData && suiWithdrawShares && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    Estimated value: ~${(parseFloat(suiWithdrawShares) * (Number(poolData.sharePrice) || 1)).toFixed(2)} USDC
                    {' '}(share price ${(Number(poolData.sharePrice) || 1).toFixed(4)})
                  </p>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Old Pool Recovery */}
          <OldPoolWithdraw />
        </div>
      </div>
    );
  }

  // EVM chains
  return (
    <div className="p-4 border-b border-gray-100 dark:border-gray-700 min-w-0">
      {/* EVM connection prompt */}
      {!evmConnected ? (
        <div className="mb-4 space-y-3">
          <div className="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg">
            <Wallet className="w-4 h-4 text-amber-500 flex-shrink-0" />
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Connect your wallet (MetaMask, OKX, etc.) to deposit and withdraw from the pool.
            </p>
          </div>
          
          <div className="text-center text-xs text-gray-500 dark:text-gray-400">
            Use the Connect Wallet button in the header
          </div>
        </div>
      ) : (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px] sm:text-sm text-gray-600 dark:text-gray-300 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Wallet className="w-4 h-4 text-green-500 flex-shrink-0" />
            <span className="truncate tabular-nums">Connected: {effectiveAddress?.slice(0, 6)}...{effectiveAddress?.slice(-4)}</span>
          </div>
          {!isChainMismatch && userUsdtBalance >= 0 && (
            <span className="text-[11px] sm:text-xs bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 rounded tabular-nums flex-shrink-0">
              Balance: ${userUsdtBalance.toFixed(2)} {tokenInfo.symbol}
            </span>
          )}
        </div>
      )}

      {/* Chain mismatch warning - wallet on different chain than selected pool */}
      {evmConnected && isChainMismatch && (
        <div className="mb-3 flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-700">
          <AlertTriangle className="w-4 h-4 text-blue-500 flex-shrink-0" />
          <p className="text-sm text-blue-700 dark:text-blue-400">
            Your wallet is on a different network. Click Deposit/Withdraw to switch to <strong>{chainConfig?.name}</strong> automatically.
          </p>
        </div>
      )}

      {/* No USDT warning */}
      {evmConnected && !isChainMismatch && userUsdtBalance === 0 && (
        <div className="mb-3 flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-700">
          <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <p className="text-sm text-amber-700 dark:text-amber-400">
            You have no {tokenInfo.symbol} on {chainConfig?.name}. Bridge or swap into {tokenInfo.symbol} on this chain to deposit.
          </p>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={() => { onShowDeposit(!showDeposit); }}
          disabled={!evmConnected}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          Deposit
        </button>
        <button
          onClick={() => { onShowWithdraw(!showWithdraw); }}
          disabled={!evmConnected || !userPosition?.isMember}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          <Minus className="w-4 h-4" />
          Withdraw
        </button>
      </div>

      {/* EVM Deposit Form */}
      <AnimatePresence>
        {showDeposit && evmConnected && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-4"
          >
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="number"
                inputMode="decimal"
                step="any"
                autoComplete="off"
                value={depositAmount}
                onChange={(e) => onDepositAmountChange(e.target.value)}
                placeholder={`Amount in USD (min $${minDeposit}${isFirstDeposit ? ' first deposit' : ''})`}
                disabled={actionLoading}
                className="flex-1 min-w-0 h-11 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-50"
              />
              <button
                onClick={onDeposit}
                disabled={actionLoading || !depositAmount || !address || isPending || isConfirming}
                className="h-11 px-6 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 active:scale-[0.98] text-white rounded-lg transition-all flex items-center justify-center gap-2 w-full sm:w-auto flex-shrink-0"
              >
                {(actionLoading || isPending || isConfirming) && <Loader2 className="w-4 h-4 animate-spin" />}
                {txStatus === 'resetting_approval' ? 'Resetting allowance...' :
                 txStatus === 'signing_permit' ? 'Sign permit (gasless)...' :
                 txStatus === 'approving' ? `Approving ${tokenInfo.symbol}...` :
                 txStatus === 'approved' ? 'Approved! Starting deposit...' :
                 txStatus === 'depositing' ? 'Depositing...' :
                 txStatus === 'complete' ? 'Complete!' :
                 `Deposit ${tokenInfo.symbol}`}
              </button>
            </div>
            {poolData && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                Current share price: ${(Number(poolData.sharePrice) || 1).toFixed(4)} — You'll receive ~{depositAmount ? (parseFloat(depositAmount) / (Number(poolData.sharePrice) || 1)).toFixed(4) : '0'} shares
              </p>
            )}
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              Deposits to on-chain CommunityPool contract. Permit-enabled tokens sign once, no separate approve tx.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* EVM Withdraw Form */}
      <AnimatePresence>
        {showWithdraw && evmConnected && userPosition?.isMember && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-4"
          >
            <div className="flex flex-wrap sm:flex-nowrap gap-2">
              <input
                type="number"
                inputMode="decimal"
                step="any"
                autoComplete="off"
                value={withdrawShares}
                onChange={(e) => onWithdrawSharesChange(e.target.value)}
                placeholder={`Shares to burn (max ${(Number(userPosition.shares) || 0).toFixed(4)})`}
                disabled={actionLoading || txStatus === 'withdrawing'}
                className="flex-1 basis-full sm:basis-auto min-w-0 h-11 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white disabled:opacity-50"
              />
              <button
                onClick={() => onWithdrawSharesChange(String(Number(userPosition.shares) || 0))}
                disabled={actionLoading || txStatus === 'withdrawing'}
                className="h-11 px-3 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 disabled:opacity-50 active:scale-[0.98] rounded-lg text-sm transition-all flex-shrink-0"
              >
                Max
              </button>
              <button
                onClick={onWithdraw}
                disabled={actionLoading || !withdrawShares || !address || txStatus === 'withdrawing' || isPending || isConfirming}
                className="h-11 px-6 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-400 active:scale-[0.98] text-white rounded-lg transition-all flex items-center justify-center gap-2 flex-1 sm:flex-none"
              >
                {(actionLoading || isPending || isConfirming || txStatus === 'withdrawing') && <Loader2 className="w-4 h-4 animate-spin" />}
                {txStatus === 'withdrawing' ? 'Withdrawing...' : 
                 txStatus === 'complete' ? 'Complete!' : 
                 'Withdraw'}
              </button>
            </div>
            {poolData && withdrawShares && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                You'll receive: ~${(parseFloat(withdrawShares) * (Number(poolData.sharePrice) || 0)).toFixed(2)} USD
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
