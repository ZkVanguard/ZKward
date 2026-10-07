'use client';

import React, { memo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { getPoolExplorerUrl } from '@/lib/contracts/community-pool-config';

interface StatusMessagesProps {
  successMessage: string | null;
  error: string | null;
  lastTxHash: string | null;
  /** Chain key for explorer URL */
  selectedChain: string;
  /** Network for explorer URL (defaults to testnet) */
  network?: 'testnet' | 'mainnet';
}

export const StatusMessages = memo(function StatusMessages({
  successMessage,
  error,
  lastTxHash,
  selectedChain,
  network = 'testnet',
}: StatusMessagesProps) {
  const explorerUrl = lastTxHash
    ? getPoolExplorerUrl(selectedChain, 'tx', lastTxHash, network)
    : '';

  return (
    <AnimatePresence>
      {successMessage && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="mx-3 sm:mx-4 mt-3 sm:mt-4 p-3 sm:p-4 bg-green-100 dark:bg-green-900/30 border border-green-300 dark:border-green-700 rounded-xl sm:rounded-lg"
        >
          <p className="text-green-700 dark:text-green-300 text-xs sm:text-sm break-words leading-relaxed">✓ {successMessage}</p>
          {lastTxHash && explorerUrl && (
            <p className="text-green-600 dark:text-green-400 text-[11px] sm:text-xs mt-1 break-all">
              Tx:{' '}
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-green-500 tabular-nums"
              >
                {lastTxHash.slice(0, 10)}...{lastTxHash.slice(-8)}
              </a>
            </p>
          )}
        </motion.div>
      )}
      {error && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="mx-3 sm:mx-4 mt-3 sm:mt-4 p-3 sm:p-4 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-xl sm:rounded-lg"
        >
          <p className="text-red-700 dark:text-red-300 text-xs sm:text-sm break-words leading-relaxed">✗ {error}</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
