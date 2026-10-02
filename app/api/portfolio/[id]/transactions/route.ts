import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { createPublicClient, http, type PublicClient, type Block } from 'viem';
import { cronos, cronosTestnet } from 'viem/chains';
import { getContractAddresses } from '@/lib/contracts/addresses';
import { getCachedTransactions, getLastCachedBlock, insertTransactions } from '@/lib/db/transactions';
import { getCronosRpcUrl, getCronosChainId } from '@/lib/throttled-provider';

export const runtime = 'nodejs';

export const maxDuration = 30;
// Collateral token address — env-driven for mainnet/testnet
const COLLATERAL_TOKEN_ADDRESS = process.env.COLLATERAL_TOKEN_ADDRESS || '0x28217daddc55e3c4831b4a48a00ce04880786967';

// Disable caching for this API route
export const dynamic = 'force-dynamic';

// Module-level singleton viem client (reused across requests)
let _viemClient: PublicClient | null = null;
function getViemClient(): PublicClient {
  if (!_viemClient) {
    _viemClient = createPublicClient({
      chain: getCronosChainId() === 25 ? cronos : cronosTestnet,
      transport: http(getCronosRpcUrl(), {
        retryCount: 3,
        retryDelay: 500,
        batch: { batchSize: 1 },
      }),
    });
  }
  return _viemClient;
}

// Token symbols mapping
const TOKEN_SYMBOLS: Record<string, string> = {
  '0xc01efaaf7c5c61bebfaeb358e1161b537b8bc0e0': 'devUSDC',
  '0x6a3173618859c7cd40faf6921b5e9eb6a76f1fd4': 'WCRO',
};

const TOKEN_DECIMALS: Record<string, number> = {
  '0xc01efaaf7c5c61bebfaeb358e1161b537b8bc0e0': 6,
  '0x6a3173618859c7cd40faf6921b5e9eb6a76f1fd4': 18,
};

interface Transaction {
  type: 'deposit' | 'withdraw' | 'rebalance';
  timestamp: number;
  amount?: number;
  token?: string;
  changes?: { from: number; to: number; asset: string }[];
  txHash: string;
  blockNumber: number;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    logger.info('[Transactions API] Starting...');
    const { id } = await context.params;
    logger.info(`[Transactions API] Portfolio ID: ${id}`);
    const portfolioId = BigInt(id);
    
    // Get wallet address from query param (for ERC20 transfer scanning and caching)
    const walletAddress = request.nextUrl.searchParams.get('address') || undefined;
    
    // ══════ DB-FIRST: Return cached transactions ══════
    const cachedTxs = await getCachedTransactions(Number(portfolioId), walletAddress);
    if (cachedTxs.length > 0) {
      logger.info(`[Transactions API] DB cache HIT: ${cachedTxs.length} transactions (no RPC)`);
      const transactions = cachedTxs.map(tx => ({
        type: tx.tx_type,
        timestamp: tx.timestamp,
        amount: tx.amount,
        token: tx.token_symbol,
        txHash: tx.tx_hash,
        blockNumber: tx.block_number,
      }));
      return NextResponse.json({ transactions, source: 'db-cache' }, {
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
      });
    }

    // ══════ DB empty: Initial scan from chain ══════
    logger.info(`[Transactions API] DB cache MISS - scanning chain for portfolio ${portfolioId}...`);
    
    const client = getViemClient();
    const addresses = getContractAddresses(338);
    logger.info(`[Transactions API] RWA Manager: ${addresses.rwaManager}`);
    
    // Get current block number
    const currentBlock = await client.getBlockNumber();
    const lastCached = BigInt(await getLastCachedBlock(Number(portfolioId), walletAddress));
    logger.info(`[Transactions API] Current block: ${currentBlock}, last cached: ${lastCached || 'none'}`);
    
    // Cronos testnet has a max range of 2000 blocks, scan in chunks
    const CHUNK_SIZE = 1999n;
    const lookback = 10000n;
    const fromBlock = lastCached > 0n ? lastCached + 1n : (currentBlock > lookback ? currentBlock - lookback : 0n);
    
    logger.info(`[Transactions API] Scanning blocks ${fromBlock} to ${currentBlock}${lastCached > 0n ? ' (incremental)' : ' (full)'}`);

    // Type definitions for event logs
    type DepositLog = { blockNumber: bigint; transactionHash: string; args: { portfolioId?: bigint; token?: string; amount?: bigint; depositor?: string } };
    type WithdrawLog = { blockNumber: bigint; transactionHash: string; args: { portfolioId?: bigint; token?: string; amount?: bigint; recipient?: string } };
    type RebalanceLog = { blockNumber: bigint; transactionHash: string; args: { portfolioId?: bigint } };
    type TransferLog = { blockNumber: bigint; transactionHash: string; args: { from: string; to: string; value: bigint } };

    const depositLogs: DepositLog[] = [];
    const withdrawLogs: WithdrawLog[] = [];
    const rebalanceLogs: RebalanceLog[] = [];
    const transferInLogs: TransferLog[] = [];
    const transferOutLogs: TransferLog[] = [];

    // Scan in chunks to avoid RPC limits
    let start = fromBlock;
    while (start <= currentBlock) {
      const end = start + CHUNK_SIZE > currentBlock ? currentBlock : start + CHUNK_SIZE;
      
      logger.debug(`[Transactions API] Chunk: ${start} to ${end}`);

      // Fetch all event types in parallel per chunk
      const eventPromises: Promise<unknown[]>[] = [
        client.getLogs({
          address: addresses.rwaManager as `0x${string}`,
          event: {
            type: 'event',
            name: 'Deposited',
            inputs: [
              { type: 'uint256', indexed: true, name: 'portfolioId' },
              { type: 'address', indexed: true, name: 'token' },
              { type: 'uint256', indexed: false, name: 'amount' },
              { type: 'address', indexed: true, name: 'depositor' },
            ],
          },
          args: { portfolioId },
          fromBlock: start,
          toBlock: end,
        }) as Promise<unknown[]>,
        client.getLogs({
          address: addresses.rwaManager as `0x${string}`,
          event: {
            type: 'event',
            name: 'Withdrawn',
            inputs: [
              { type: 'uint256', indexed: true, name: 'portfolioId' },
              { type: 'address', indexed: true, name: 'token' },
              { type: 'uint256', indexed: false, name: 'amount' },
              { type: 'address', indexed: true, name: 'recipient' },
            ],
          },
          args: { portfolioId },
          fromBlock: start,
          toBlock: end,
        }) as Promise<unknown[]>,
        client.getLogs({
          address: addresses.rwaManager as `0x${string}`,
          event: {
            type: 'event',
            name: 'Rebalanced',
            inputs: [
              { type: 'uint256', indexed: true, name: 'portfolioId' },
            ],
          },
          args: { portfolioId },
          fromBlock: start,
          toBlock: end,
        }) as Promise<unknown[]>,
      ];

      // Also scan for ERC20 Transfer events if we have a wallet address
      if (walletAddress) {
        // Transfers TO the wallet (deposits/mints)
        eventPromises.push(
          client.getLogs({
            address: COLLATERAL_TOKEN_ADDRESS as `0x${string}`,
            event: {
              type: 'event',
              name: 'Transfer',
              inputs: [
                { type: 'address', indexed: true, name: 'from' },
                { type: 'address', indexed: true, name: 'to' },
                { type: 'uint256', indexed: false, name: 'value' },
              ],
            },
            args: { to: walletAddress as `0x${string}` },
            fromBlock: start,
            toBlock: end,
          }) as Promise<unknown[]>
        );
        // Transfers FROM the wallet (withdraws/sends)
        eventPromises.push(
          client.getLogs({
            address: COLLATERAL_TOKEN_ADDRESS as `0x${string}`,
            event: {
              type: 'event',
              name: 'Transfer',
              inputs: [
                { type: 'address', indexed: true, name: 'from' },
                { type: 'address', indexed: true, name: 'to' },
                { type: 'uint256', indexed: false, name: 'value' },
              ],
            },
            args: { from: walletAddress as `0x${string}` },
            fromBlock: start,
            toBlock: end,
          }) as Promise<unknown[]>
        );
      }

      const results = await Promise.all(eventPromises);
      const [chunkDeposits, chunkWithdraws, chunkRebalances, chunkTransfersIn, chunkTransfersOut] = results;

      depositLogs.push(...(chunkDeposits as typeof depositLogs));
      withdrawLogs.push(...(chunkWithdraws as typeof withdrawLogs));
      rebalanceLogs.push(...(chunkRebalances as typeof rebalanceLogs));
      
      if (chunkTransfersIn) {
        transferInLogs.push(...(chunkTransfersIn as typeof transferInLogs));
      }
      if (chunkTransfersOut) {
        transferOutLogs.push(...(chunkTransfersOut as typeof transferOutLogs));
      }
      
      start = end + 1n;
    }

    logger.info(`[Transactions API] Found ${depositLogs.length} deposits, ${withdrawLogs.length} withdrawals, ${rebalanceLogs.length} rebalances, ${transferInLogs.length} transfers in, ${transferOutLogs.length} transfers out`);

    const transactions: Transaction[] = [];

    // Deduplicate block fetches: collect all unique block numbers, fetch each once
    const allLogs = [
      ...depositLogs.map(l => ({ ...l, _type: 'deposit' as const })),
      ...withdrawLogs.map(l => ({ ...l, _type: 'withdraw' as const })),
      ...rebalanceLogs.map(l => ({ ...l, _type: 'rebalance' as const })),
      ...transferInLogs.map(l => ({ ...l, _type: 'transfer_in' as const })),
      ...transferOutLogs.map(l => ({ ...l, _type: 'transfer_out' as const })),
    ];
    const uniqueBlockNumbers = [...new Set(allLogs.map(l => l.blockNumber))];
    const blockMap = new Map<bigint, Block>();
    
    // Fetch blocks in parallel batches of 5
    for (let i = 0; i < uniqueBlockNumbers.length; i += 5) {
      const batch = uniqueBlockNumbers.slice(i, i + 5);
      const blocks = await Promise.all(
        batch.map(bn => client.getBlock({ blockNumber: bn }).catch(() => null))
      );
      for (let j = 0; j < batch.length; j++) {
        if (blocks[j]) blockMap.set(batch[j], blocks[j]!);
      }
    }

    // Process deposits
    for (const log of depositLogs) {
      try {
        const block = blockMap.get(log.blockNumber);
        if (!block) continue;
        const token = log.args.token?.toLowerCase() || '';
        const amount = log.args.amount || 0n;
        const decimals = TOKEN_DECIMALS[token] || 18;
        const symbol = TOKEN_SYMBOLS[token] || 'Unknown';
        
        logger.debug(`Processing deposit: ${symbol} ${amount} at block ${log.blockNumber}`);
        
        transactions.push({
          type: 'deposit',
          timestamp: Number(block.timestamp) * 1000,
          amount: Number(amount) / Math.pow(10, decimals),
          token: symbol,
          txHash: log.transactionHash || '',
          blockNumber: Number(log.blockNumber),
        });
      } catch (err: unknown) {
        logger.error('Error processing deposit log', err);
      }
    }

    // Process withdrawals
    for (const log of withdrawLogs) {
      try {
        const block = blockMap.get(log.blockNumber);
        if (!block) continue;
        const token = log.args.token?.toLowerCase() || '';
        const amount = log.args.amount || 0n;
        const decimals = TOKEN_DECIMALS[token] || 18;
        const symbol = TOKEN_SYMBOLS[token] || 'Unknown';
        
        transactions.push({
          type: 'withdraw',
          timestamp: Number(block.timestamp) * 1000,
          amount: Number(amount) / Math.pow(10, decimals),
          token: symbol,
          txHash: log.transactionHash || '',
          blockNumber: Number(log.blockNumber),
        });
      } catch (err: unknown) {
        logger.error('Error processing withdrawal log', err);
      }
    }

    // Process rebalances
    for (const log of rebalanceLogs) {
      try {
        const block = blockMap.get(log.blockNumber);
        if (!block) continue;
        
        transactions.push({
          type: 'rebalance',
          timestamp: Number(block.timestamp) * 1000,
          txHash: log.transactionHash || '',
          blockNumber: Number(log.blockNumber),
        });
      } catch (err: unknown) {
        logger.error('Error processing rebalance log', err);
      }
    }

    // Process ERC20 transfers IN (mints, receives)
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
    for (const log of transferInLogs) {
      try {
        const block = blockMap.get(log.blockNumber);
        if (!block) continue;
        
        const value = log.args.value || 0n;
        const from = log.args.from?.toLowerCase() || '';
        const isMint = from === ZERO_ADDRESS;
        
        transactions.push({
          type: 'deposit',
          timestamp: Number(block.timestamp) * 1000,
          amount: Number(value) / Math.pow(10, 6), // USDC has 6 decimals
          token: isMint ? 'USDC (Minted)' : 'USDC',
          txHash: log.transactionHash || '',
          blockNumber: Number(log.blockNumber),
        });
      } catch (err: unknown) {
        logger.error('Error processing transfer in log', err);
      }
    }

    // Process ERC20 transfers OUT (burns, sends)
    for (const log of transferOutLogs) {
      try {
        const block = blockMap.get(log.blockNumber);
        if (!block) continue;
        
        const value = log.args.value || 0n;
        const to = log.args.to?.toLowerCase() || '';
        const isBurn = to === ZERO_ADDRESS;
        
        transactions.push({
          type: 'withdraw',
          timestamp: Number(block.timestamp) * 1000,
          amount: Number(value) / Math.pow(10, 6), // USDC has 6 decimals
          token: isBurn ? 'USDC (Burned)' : 'USDC',
          txHash: log.transactionHash || '',
          blockNumber: Number(log.blockNumber),
        });
      } catch (err: unknown) {
        logger.error('Error processing transfer out log', err);
      }
    }

    // Sort by timestamp descending (most recent first)
    transactions.sort((a, b) => b.timestamp - a.timestamp);

    logger.info(`[Transactions API] Returning ${transactions.length} transactions`);
    if (transactions.length > 0) {
      logger.debug('Sample transaction', { data: transactions[0] });
      
      // ══════ Persist to DB for future instant serving ══════
      insertTransactions(transactions.map(tx => ({
        portfolioId: Number(portfolioId),
        txType: tx.type,
        txHash: tx.txHash,
        blockNumber: tx.blockNumber,
        timestamp: tx.timestamp,
        tokenSymbol: tx.token,
        amount: tx.amount,
        contractAddress: addresses.rwaManager,
        walletAddress: walletAddress || undefined,
      }))).then(inserted => {
        logger.info(`[Transactions API] Persisted ${inserted} new transactions to DB`);
      }).catch(err => {
        logger.warn('Failed to persist transactions to DB (non-critical)', err);
      });
    }

    return NextResponse.json({ transactions, source: 'chain-scan' }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (error: unknown) {
    logger.error('[Transactions API] Error', error);
    return safeErrorResponse(error, 'Transaction fetch');
  }
}
