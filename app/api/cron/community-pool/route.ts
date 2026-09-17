/**
 * Cron Job: Community Pool AI Management
 * 
 * This endpoint is invoked by Upstash QStash (or master cron) to:
 * 1. Check community pool risk metrics via all AI agents
 * 2. Execute AI allocation decisions
 * 3. Trigger auto-hedging when needed
 * 
 * AI Agents Involved:
 * - RiskAgent: Assesses portfolio risk and drawdown
 * - HedgingAgent: Generates and executes hedge recommendations
 * - PriceMonitorAgent: Monitors price movements and alerts
 * - ReportingAgent: Generates performance reports
 * - SettlementAgent: Handles pool settlements
 * 
 * Schedule: Every 30 minutes via QStash
 * 
 * Security: Verified by QStash signature or CRON_SECRET
 * 
 * SECURITY HARDENED:
 * - Uses SecureAgentSigner with rate limiting and circuit breaker
 * - Multi-source price validation to prevent manipulation
 * - Respects on-chain reserve ratio requirements (MIN_RESERVE_RATIO_BPS)
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { logger } from '@/lib/utils/logger';
import { envFlag } from '@/lib/utils/env-flag';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { verifyCronRequest } from '@/lib/qstash';
import { autoHedgingService } from '@/lib/services/hedging/AutoHedgingService';
import { getAgentOrchestrator } from '@/lib/services/agent-orchestrator';
import { recordNavSnapshot, initCommunityPoolTables, saveUserSharesToDb, savePoolStateToDb, addPoolTransactionToDb, getAllUserSharesFromDb, deleteUserSharesFromDb } from '@/lib/db/community-pool';
import { ethers } from 'ethers';
import { getCronosRpcUrl } from '@/lib/throttled-provider';
import { COMMUNITY_POOL_PORTFOLIO_ID } from '@/lib/constants';
import { SecureAgentSigner, getSecureAgentSigner } from '@/lib/services/hedging/SecureAgentSigner';
import { getMultiSourceValidatedPrice } from '@/lib/services/market-data/unified-price-provider';

export const runtime = 'nodejs';
export const maxDuration = 180;

// CommunityPool contract details
const COMMUNITY_POOL_ADDRESS = '0xC25A8D76DDf946C376c9004F5192C7b2c27D5d30';
const COMMUNITY_POOL_ABI = [
  'function getPoolStats() view returns (uint256 _totalShares, uint256 _totalNAV, uint256 _memberCount, uint256 _sharePrice, uint256[4] _allocations)',
  'function setTargetAllocation(uint256[4] newAllocationBps, string reasoning)',
  'function executeRebalanceTrade(uint8 assetIndex, uint256 amount, bool isBuy, uint256 minAmountOut)',
  'function getMemberCount() view returns (uint256)',
  'function memberList(uint256) view returns (address)',
  'function members(address) view returns (uint256 shares, uint256 depositedUSD, uint256 withdrawnUSD, uint256 joinTime)',
  'function openPoolHedge(address hedgeContract, uint256 collateralAmount, bytes32 positionId, uint256 expectedPayout)',
  'function depositToken() view returns (address)',
  'function assetTokens(uint256) view returns (address)',
  'function assetBalances(uint256) view returns (uint256)',
  'function dexRouter() view returns (address)',
  'function MIN_RESERVE_RATIO_BPS() view returns (uint256)',
  'function MAX_SINGLE_HEDGE_BPS() view returns (uint256)',
  'function DAILY_HEDGE_CAP_BPS() view returns (uint256)',
];

const VVS_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
];

// Asset indices matching CommunityPool.sol constants
const _ASSET_BTC = 0;
const _ASSET_ETH = 1;
const _ASSET_SUI = 2;
const _ASSET_CRO = 3;
const ASSET_NAMES = ['BTC', 'ETH', 'SUI', 'CRO'] as const;

// Minimum USDC to allocate per asset ($1 min to avoid wasting gas)
const MIN_TRADE_USDC = 1_000_000n; // $1 in 6 decimals
// Accept up to 3% slippage from DEX quote
const MAX_SLIPPAGE_BPS = 300n;

interface CronResult {
  success: boolean;
  poolStats?: {
    totalNAV: string;
    memberCount: number;
    sharePrice: string;
    allocations: { BTC: number; ETH: number; SUI: number; CRO: number };
  };
  riskAssessment?: {
    riskScore: number;
    drawdownPercent: number;
    volatility: number;
    recommendations: number;
  };
  aiDecision?: {
    action: string;
    reasoning: string;
    executed: boolean;
    txHash?: string;
    executionError?: string;
  };
  hedgesExecuted?: number;
  rebalanceTrades?: {
    executed: number;
    failed: number;
    skipped: number;
    trades: Array<{
      asset: string;
      amountUsdc: string;
      amountReceived: string;
      txHash?: string;
      error?: string;
    }>;
  };
  priceValidation?: {
    BTC?: { price: number; confidence: string };
    ETH?: { price: number; confidence: string };
  };
  signerStatus?: {
    isAvailable: boolean;
    dailyUsedUSD: number;
    remainingDailyUSD: number;
    circuitBreakerOpen: boolean;
  };
  agentStatus?: {
    active: string[];
    inactive: string[];
  };
  duration: number;
  error?: string;
}

// Helper to get secure signer with availability check
function getSecureSignerIfAvailable(): SecureAgentSigner | null {
  try {
    const signer = getSecureAgentSigner();
    const availability = signer.isAvailable();
    if (availability.available) {
      logger.info('[CommunityPool Cron] SecureAgentSigner is available');
      return signer;
    } else {
      logger.warn('[CommunityPool Cron] SecureAgentSigner unavailable', { reason: availability.reason });
      return null;
    }
  } catch (error) {
    logger.error('[CommunityPool Cron] Failed to get SecureAgentSigner', { error });
    return null;
  }
}

/**
 * Vercel Cron Job Handler
 * Invoked automatically every 4 hours
 */
export async function GET(request: NextRequest): Promise<NextResponse<CronResult>> {
  const startTime = Date.now();
  
  // Security: Verify QStash signature or CRON_SECRET
  const authResult = await verifyCronRequest(request, 'CommunityPool Cron');
  if (authResult !== true) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized', duration: Date.now() - startTime },
      { status: 401 }
    );
  }
  
  logger.info('[CommunityPool Cron] Starting scheduled pool management');
  
  try {
    // Step 1: Fetch on-chain pool stats
    const provider = new ethers.JsonRpcProvider(getCronosRpcUrl());
    const poolContract = new ethers.Contract(COMMUNITY_POOL_ADDRESS, COMMUNITY_POOL_ABI, provider);
    
    const stats = await poolContract.getPoolStats();
    const poolStats = {
      totalNAV: ethers.formatUnits(stats._totalNAV, 6),
      memberCount: Number(stats._memberCount),
      sharePrice: ethers.formatUnits(stats._sharePrice, 6), // USDC has 6 decimals
      allocations: {
        BTC: Number(stats._allocations[0]) / 100,
        ETH: Number(stats._allocations[1]) / 100,
        SUI: Number(stats._allocations[2]) / 100,
        CRO: Number(stats._allocations[3]) / 100,
      },
    };
    
    logger.info('[CommunityPool Cron] Pool stats fetched', {
      totalNAV: `$${poolStats.totalNAV}`,
      memberCount: poolStats.memberCount,
      allocations: poolStats.allocations,
    });
    
    // Step 1.5: Record NAV snapshot for risk metrics history
    // NAV is from on-chain contract, share price adjusted with live market prices
    try {
      // Ensure tables exist (idempotent)
      await initCommunityPoolTables();
      
      // Use on-chain contract values as base
      const totalShares = parseFloat(ethers.formatUnits(stats._totalShares, 18));
      const onChainNAV = parseFloat(ethers.formatUnits(stats._totalNAV, 6));
      const baseSharePrice = parseFloat(ethers.formatUnits(stats._sharePrice, 6));
      
      // Share price from on-chain contract, enriched with live market prices
      let sharePrice = baseSharePrice;
      const hasAllocations = poolStats.allocations.BTC > 0 || poolStats.allocations.ETH > 0;
      
      if (hasAllocations) {
        try {
          // Get live prices for real portfolio valuation
          const [btcPrice, ethPrice] = await Promise.all([
            getMultiSourceValidatedPrice('BTC'),
            getMultiSourceValidatedPrice('ETH'),
          ]);
          
          // Use on-chain NAV as the authoritative value
          const btcWeight = (poolStats.allocations?.BTC ?? 0) / 100;
          const ethWeight = (poolStats.allocations?.ETH ?? 0) / 100;
          const suiWeight = (poolStats.allocations?.SUI ?? 0) / 100;
          const croWeight = (poolStats.allocations?.CRO ?? 0) / 100;
          
          // Share price is authoritative from on-chain contract
          sharePrice = baseSharePrice;
          
          logger.info('[CommunityPool Cron] NAV snapshot with live prices', {
            basePrice: baseSharePrice.toFixed(6),
            sharePrice: sharePrice.toFixed(6),
            btcPrice: btcPrice.price.toFixed(2),
            ethPrice: ethPrice.price.toFixed(2),
            allocations: { btcWeight, ethWeight, suiWeight, croWeight },
          });
        } catch (priceError) {
          logger.warn('[CommunityPool Cron] Failed to fetch live prices, using on-chain base', { error: priceError });
        }
      }
      
      await recordNavSnapshot({
        sharePrice: sharePrice,
        totalNav: onChainNAV,
        totalShares: totalShares,
        memberCount: poolStats.memberCount,
        allocations: {
          BTC: poolStats.allocations.BTC,
          ETH: poolStats.allocations.ETH,
          SUI: poolStats.allocations.SUI,
          CRO: poolStats.allocations.CRO,
        },
        source: 'on-chain-contract',
        chain: 'cronos',
      });
      logger.info('[CommunityPool Cron] NAV snapshot recorded from on-chain data', {
        onChainNAV: `$${onChainNAV.toFixed(2)}`,
        sharePrice: `$${sharePrice.toFixed(6)}`,
        totalShares: totalShares.toFixed(2),
      });
      
      // Step 1.6: AUTHORITATIVE sync - DB must match on-chain exactly
      // This deletes ghost entries and ensures DB reflects on-chain state
      try {
        const memberCount = Number(await poolContract.getMemberCount());
        const onChainAddresses = new Set<string>();
        let syncedMembers = 0;
        let activeMembers = 0;
        
        // First pass: Get all on-chain members and sync to DB
        for (let i = 0; i < memberCount; i++) {
          try {
            const addr = await poolContract.memberList(i);
            const addrLower = addr.toLowerCase();
            onChainAddresses.add(addrLower);
          
            const memberData = await poolContract.members(addr);
            const shares = parseFloat(ethers.formatUnits(memberData.shares, 18));
          
            await saveUserSharesToDb({
              walletAddress: addrLower,
              shares: shares,
              costBasisUSD: parseFloat(ethers.formatUnits(memberData.depositedUSD, 6)),
              chain: 'cronos',
            });
            syncedMembers++;
            if (shares > 0) activeMembers++;
          } catch (memberErr) {
            logger.error(`[CommunityPool Cron] Failed to sync member ${i}`, { error: memberErr });
            // Continue to next member — don't let one failure stop the whole sync
          }
        }
        
        // Second pass: DELETE any DB entries not found on-chain (ghost cleanup)
        const dbEntries = await getAllUserSharesFromDb();
        let deletedGhosts = 0;
        for (const entry of dbEntries) {
          const dbAddr = entry.wallet_address.toLowerCase();
          // Only delete cronos entries that aren't on-chain anymore
          if (entry.chain === 'cronos' && !onChainAddresses.has(dbAddr)) {
            await deleteUserSharesFromDb(entry.wallet_address);
            logger.warn('[CommunityPool Cron] Deleted ghost DB entry', { address: dbAddr, hadShares: entry.shares });
            deletedGhosts++;
          }
        }
        
        logger.info('[CommunityPool Cron] Authoritative sync complete', {
          onChainMembers: memberCount,
          activeMembers,
          syncedMembers,
          deletedGhosts,
        });
        
        // Also sync pool state
        const poolAllocRecord: Record<string, { percentage: number; valueUSD: number; amount: number; price: number }> = {};
        for (const [asset, pct] of Object.entries(poolStats.allocations)) {
          poolAllocRecord[asset] = { percentage: pct, valueUSD: onChainNAV * (pct / 100), amount: 0, price: 0 };
        }
        await savePoolStateToDb({
          totalValueUSD: onChainNAV,
          totalShares: totalShares,
          sharePrice: baseSharePrice,
          allocations: poolAllocRecord,
          lastRebalance: Date.now(),
          lastAIDecision: null,
          chain: 'cronos',
        });
        
        logger.info('[CommunityPool Cron] DB cache synced from on-chain', { syncedMembers });
      } catch (syncError) {
        logger.warn('[CommunityPool Cron] Failed to sync members to DB (non-critical)', { error: syncError });
      }
    } catch (navError) {
      logger.warn('[CommunityPool Cron] Failed to record NAV snapshot (non-critical)', { error: navError });
    }
    
    // Step 2: Run risk assessment via AutoHedgingService
    // This triggers all AI agents: RiskAgent, HedgingAgent, PriceMonitorAgent
    const riskAssessment = await autoHedgingService.triggerRiskAssessment(COMMUNITY_POOL_PORTFOLIO_ID, COMMUNITY_POOL_ADDRESS);
    
    logger.info('[CommunityPool Cron] Risk assessment complete', {
      riskScore: riskAssessment.riskScore,
      recommendations: riskAssessment.recommendations.length,
    });

    // Step 2.5: Get agent orchestrator status
    let agentStatus: { active: string[]; inactive: string[] } = { active: [], inactive: [] };
    try {
      const orchestrator = getAgentOrchestrator();
      const status = orchestrator.getStatus();
      agentStatus = {
        active: Object.entries(status.agents)
          .filter(([, v]) => v)
          .map(([k]) => k),
        inactive: Object.entries(status.agents)
          .filter(([, v]) => !v)
          .map(([k]) => k),
      };
      logger.info('[CommunityPool Cron] Agent orchestrator status', {
        initialized: status.initialized,
        activeAgents: agentStatus.active,
      });
    } catch (orchError) {
      logger.warn('[CommunityPool Cron] Could not get orchestrator status', { error: orchError });
    }
    
    // Step 3: Get AI allocation decision
    let aiDecision: CronResult['aiDecision'] = {
      action: 'HOLD',
      reasoning: 'Risk within acceptable parameters, no rebalancing needed',
      executed: false,
    };

    // Check if prediction-driven hedges were generated
    const predictionRecs = riskAssessment.recommendations.filter(r => r.reason.startsWith('[PREDICTION]'));
    const hedgeRecs = riskAssessment.recommendations.filter(r => r.confidence >= 0.7);
    
    if (predictionRecs.length > 0 && hedgeRecs.length > 0) {
      // Prediction-driven hedges were created and will be executed by triggerRiskAssessment
      const topRec = predictionRecs[0];
      aiDecision = {
        action: topRec.side === 'LONG' ? 'HEDGE_LONG' : 'HEDGE_SHORT',
        reasoning: topRec.reason,
        executed: true, // triggerRiskAssessment already executed these
      };
      logger.info('[CommunityPool Cron] Prediction-driven hedge action taken', {
        recommendations: predictionRecs.length,
        topAsset: topRec.asset,
        topSide: topRec.side,
        topSize: topRec.suggestedSize,
        topConfidence: topRec.confidence,
      });
    } else if (hedgeRecs.length > 0) {
      // Risk-driven hedges (drawdown, concentration, etc.)
      const topRec = hedgeRecs[0];
      aiDecision = {
        action: 'HEDGE_SHORT',
        reasoning: topRec.reason,
        executed: true,
      };
    }
    
    // Track price validation results
    let priceValidation: CronResult['priceValidation'] = {};
    let signerStatus: CronResult['signerStatus'] = {
      isAvailable: false,
      dailyUsedUSD: 0,
      remainingDailyUSD: 0,
      circuitBreakerOpen: false,
    };
    
    // Initialize secure signer and report status
    const secureSigner = getSecureSignerIfAvailable();
    if (secureSigner) {
      const status = await secureSigner.getStatus();
      signerStatus = {
        isAvailable: status.available,
        dailyUsedUSD: status.dailyVolumeUSD,
        remainingDailyUSD: status.config.maxDailyTxUSD - status.dailyVolumeUSD,
        circuitBreakerOpen: status.circuitOpen,
      };
    }
    
    // Only trigger AI decision if risk is elevated
    if (riskAssessment.riskScore >= 4) {
      // First, validate prices from multiple sources to prevent manipulation
      let priceValidationPassed = false;
      try {
        const btcValidation = await getMultiSourceValidatedPrice('BTC');
        const ethValidation = await getMultiSourceValidatedPrice('ETH');
        
        priceValidation = {
          BTC: { price: btcValidation.price, confidence: btcValidation.confidence },
          ETH: { price: ethValidation.price, confidence: ethValidation.confidence },
        };
        
        logger.info('[CommunityPool Cron] Price validation passed', {
          BTC: `$${btcValidation.price.toFixed(2)} (${btcValidation.confidence})`,
          ETH: `$${ethValidation.price.toFixed(2)} (${ethValidation.confidence})`,
        });
        
        // Reject low confidence prices
        if (btcValidation.confidence === 'low' || ethValidation.confidence === 'low') {
          logger.warn('[CommunityPool Cron] Skipping execution due to low price confidence');
          aiDecision = {
            action: 'HOLD',
            reasoning: 'Price manipulation risk detected - oracle confidence too low',
            executed: false,
          };
        } else {
          // Price validation passed with acceptable confidence
          priceValidationPassed = true;
        }
      } catch (priceError) {
        logger.error('[CommunityPool Cron] Price validation failed - possible manipulation', { error: priceError });
        aiDecision = {
          action: 'HOLD',
          reasoning: `Price validation failed: ${priceError instanceof Error ? priceError.message : 'Unknown error'}`,
          executed: false,
        };
      }
      
      // Only proceed if price validation passed with good confidence
      if (priceValidationPassed) {
        try {
        const baseUrl = process.env.VERCEL 
          ? 'https://zkward.com'
          : process.env.NEXT_PUBLIC_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
        const aiResponse = await fetch(`${baseUrl}/api/community-pool/ai-decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            action: 'generateAllocation',
            marketConditions: {
              riskScore: riskAssessment.riskScore,
              drawdownPercent: riskAssessment.drawdownPercent,
              volatility: riskAssessment.volatility,
              currentAllocations: poolStats.allocations,
            },
          }),
        });
        
        if (aiResponse.ok) {
          const aiData = await aiResponse.json();
          
          // Check if AI recommends rebalancing
          if (aiData.recommendation?.shouldRebalance) {
            aiDecision = {
              action: 'REBALANCE',
              reasoning: aiData.recommendation.reasoning || 'AI recommends allocation adjustment',
              executed: false,
            };
            
            // Execute rebalancing if auto-approval is enabled. envFlag accepts
            // '1'|'true'|'yes'|'on' — canonical parser prevents the silent-fail
            // class fixed in e6a80411 (this call site was one of the two).
            const autoApprovalEnabled = envFlag('COMMUNITY_POOL_AUTO_REBALANCE');
            const navThresholdRaw = parseFloat(process.env.COMMUNITY_POOL_NAV_THRESHOLD || '0');
            const navThreshold = Number.isFinite(navThresholdRaw) && navThresholdRaw > 0 ? navThresholdRaw : 100000;
            const currentNAV = Number(poolStats.totalNAV) || 0;
            
            if (!Number.isFinite(currentNAV) || currentNAV < 0) {
              logger.error('[CommunityPool Cron] Invalid NAV value — aborting rebalance', { nav: poolStats.totalNAV });
            } else if (autoApprovalEnabled && currentNAV <= navThreshold && secureSigner) {
              logger.info('[CommunityPool Cron] Auto-executing rebalance', {
                newAllocations: aiData.recommendation.allocations,
              });
              
              try {
                // Get validated transaction amount
                const amountUSD = aiData.recommendation.hedgeAmountUSD || 0;
                
                if (amountUSD > 0) {
                  // Create contract instance for SecureAgentSigner
                  // The signer gets the wallet internally
                  const provider = new ethers.JsonRpcProvider(getCronosRpcUrl());
                  const poolContract = new ethers.Contract(
                    COMMUNITY_POOL_ADDRESS,
                    COMMUNITY_POOL_ABI,
                    provider
                  );
                  
                  // Convert allocations to BPS format for contract
                  const allocationsBps: [bigint, bigint, bigint, bigint] = [
                    BigInt(Math.round((aiData.recommendation.allocations?.BTC || poolStats.allocations.BTC) * 100)),
                    BigInt(Math.round((aiData.recommendation.allocations?.ETH || poolStats.allocations.ETH) * 100)),
                    BigInt(Math.round((aiData.recommendation.allocations?.SUI || poolStats.allocations.SUI) * 100)),
                    BigInt(Math.round((aiData.recommendation.allocations?.CRO || poolStats.allocations.CRO) * 100)),
                  ];
                  
                  // Validate allocation BPS sum matches expected total
                  const totalBps = allocationsBps.reduce((sum, bps) => sum + bps, 0n);
                  if (totalBps > 10000n) {
                    throw new Error(`Allocation BPS sum ${totalBps} exceeds 10000 (100%)`);
                  }
                  
                  // Validate individual allocations are non-negative
                  for (let i = 0; i < allocationsBps.length; i++) {
                    if (allocationsBps[i] < 0n) {
                      throw new Error(`Negative allocation at index ${i}: ${allocationsBps[i]}`);
                    }
                  }
                  
                  // Check MIN_RESERVE_RATIO_BPS constraint
                  try {
                    const minReserveBps = await poolContract.MIN_RESERVE_RATIO_BPS();
                    const maxAllocationBps = 10000n - BigInt(Number(minReserveBps));
                    if (totalBps > maxAllocationBps) {
                      throw new Error(`Allocation ${totalBps}bps exceeds max ${maxAllocationBps}bps (reserve ratio ${minReserveBps}bps)`);
                    }
                  } catch (reserveCheckErr) {
                    if (reserveCheckErr instanceof Error && reserveCheckErr.message.includes('Allocation')) {
                      throw reserveCheckErr; // Re-throw our validation error
                    }
                    logger.warn('[CommunityPool Cron] Could not read MIN_RESERVE_RATIO_BPS, proceeding with sum check only', { error: reserveCheckErr });
                  }
                  
                  // Sign and execute via SecureAgentSigner with rate limiting
                  // signAndSend(contract, method, params, valueUSD, options?)
                  const result = await secureSigner.signAndSend(
                    poolContract,
                    'setTargetAllocation',
                    [allocationsBps, `AI reallocation: ${aiData.recommendation.reasoning}`],
                    amountUSD,
                    { description: `Pool rebalance - Risk score ${riskAssessment.riskScore}` }
                  );
                  
                  if (result.success) {
                    aiDecision.executed = true;
                    aiDecision.txHash = result.txHash;
                    
                    logger.info('[CommunityPool Cron] Allocation targets updated on-chain', {
                      txHash: result.txHash,
                    });
                  } else {
                    throw new Error(result.error || 'Unknown error from signer');
                  }
                } else {
                  aiDecision.reasoning += ' (No hedge amount specified by AI)';
                }
              } catch (execError) {
                const errorMsg = execError instanceof Error ? execError.message : 'Unknown execution error';
                aiDecision.executed = false;
                aiDecision.executionError = errorMsg;
                aiDecision.reasoning += ` (Execution failed: ${errorMsg})`;
                
                logger.error('[CommunityPool Cron] Rebalance execution failed', { error: errorMsg });
              }
            } else if (!secureSigner) {
              aiDecision.reasoning += ' (SecureAgentSigner unavailable - check AGENT_SIGNER_KEY)';
            } else if (!autoApprovalEnabled) {
              aiDecision.reasoning += ` (Auto-execution disabled - COMMUNITY_POOL_AUTO_REBALANCE="${process.env.COMMUNITY_POOL_AUTO_REBALANCE ?? ''}"; expected '1' or 'true')`;
            } else if (currentNAV > navThreshold) {
              aiDecision.reasoning += ` (NAV $${currentNAV.toFixed(2)} exceeds threshold $${navThreshold} - manual approval required)`;
            }
          }
        }
        } catch (aiError) {
          logger.warn('[CommunityPool Cron] AI decision fetch failed', { error: aiError });
        }
      }
    }
    
    // Step 3.5: Execute on-chain trades to convert USDC into target assets
    // This is the CRITICAL step that actually buys BTC/ETH/SUI/CRO via VVS Finance DEX
    let rebalanceTrades: CronResult['rebalanceTrades'] = undefined;
    if (aiDecision.executed || poolStats.allocations.BTC > 0) {
      try {
        const provider = new ethers.JsonRpcProvider(getCronosRpcUrl());
        const tradeContract = new ethers.Contract(COMMUNITY_POOL_ADDRESS, COMMUNITY_POOL_ABI, provider);
        
        // Read unallocated USDC balance in the contract
        const depositTokenAddr: string = await tradeContract.depositToken();
        const usdcContract = new ethers.Contract(
          depositTokenAddr,
          ['function balanceOf(address) view returns (uint256)'],
          provider,
        );
        const usdcBalance: bigint = await usdcContract.balanceOf(COMMUNITY_POOL_ADDRESS);
        
        // Read DEX router address
        const routerAddr: string = await tradeContract.dexRouter();
        
        // Read current asset balances
        const currentBalances: bigint[] = [];
        const assetAddrs: string[] = [];
        for (let i = 0; i < 4; i++) {
          currentBalances.push(await tradeContract.assetBalances(i));
          assetAddrs.push(await tradeContract.assetTokens(i));
        }
        
        // Only proceed if there is meaningful USDC to allocate and DEX router is configured
        const minPoolUsdc = 10_000_000n; // $10 minimum pool USDC to trigger trades
        if (usdcBalance > minPoolUsdc && routerAddr !== ethers.ZeroAddress) {
          // Reserve 5% of USDC for withdrawal liquidity (matching MIN_RESERVE_RATIO_BPS)
          let reserveBps = 500n;
          try {
            reserveBps = BigInt(Number(await tradeContract.MIN_RESERVE_RATIO_BPS()));
          } catch { /* use default 5% */ }
          const reserveUsdc = (usdcBalance * reserveBps) / 10000n;
          const allocatableUsdc = usdcBalance - reserveUsdc;
          
          if (allocatableUsdc > minPoolUsdc) {
            const router = new ethers.Contract(routerAddr, VVS_ROUTER_ABI, provider);
            const trades: NonNullable<CronResult['rebalanceTrades']>['trades'] = [];
            let executed = 0;
            let failed = 0;
            let skipped = 0;
            
            // Use current on-chain target allocations (just set by setTargetAllocation)
            const targetBps = [
              poolStats.allocations.BTC * 100,
              poolStats.allocations.ETH * 100,
              poolStats.allocations.SUI * 100,
              poolStats.allocations.CRO * 100,
            ];
            
            for (let i = 0; i < 4; i++) {
              const assetName = ASSET_NAMES[i];
              const assetAddr = assetAddrs[i];
              
              // Skip if asset token not configured on this chain
              if (assetAddr === ethers.ZeroAddress) {
                trades.push({ asset: assetName, amountUsdc: '0', amountReceived: '0', error: 'Asset token not configured' });
                skipped++;
                continue;
              }
              
              // Calculate USDC allocation for this asset
              const assetUsdc = (allocatableUsdc * BigInt(Math.round(targetBps[i]))) / 10000n;
              if (assetUsdc < MIN_TRADE_USDC) {
                trades.push({ asset: assetName, amountUsdc: ethers.formatUnits(assetUsdc, 6), amountReceived: '0', error: 'Below minimum trade size' });
                skipped++;
                continue;
              }
              
              try {
                // Get DEX quote for slippage protection
                const path = [depositTokenAddr, assetAddr];
                const amounts: bigint[] = await router.getAmountsOut(assetUsdc, path);
                const expectedOut = amounts[amounts.length - 1];
                
                // Apply slippage tolerance
                const minOut = (expectedOut * (10000n - MAX_SLIPPAGE_BPS)) / 10000n;
                
                // Execute trade via SecureAgentSigner
                if (secureSigner) {
                  const tradeResult = await secureSigner.signAndSend(
                    tradeContract,
                    'executeRebalanceTrade',
                    [i, assetUsdc, true, minOut], // assetIndex, amount, isBuy=true, minAmountOut
                    Number(ethers.formatUnits(assetUsdc, 6)),
                    { description: `Buy ${assetName} with $${ethers.formatUnits(assetUsdc, 6)} USDC` },
                  );
                  
                  if (tradeResult.success) {
                    trades.push({
                      asset: assetName,
                      amountUsdc: ethers.formatUnits(assetUsdc, 6),
                      amountReceived: expectedOut.toString(),
                      txHash: tradeResult.txHash,
                    });
                    executed++;
                    logger.info(`[CommunityPool Cron] Trade executed: $${ethers.formatUnits(assetUsdc, 6)} USDC → ${assetName}`, {
                      txHash: tradeResult.txHash,
                      expectedOut: expectedOut.toString(),
                    });
                  } else {
                    trades.push({
                      asset: assetName,
                      amountUsdc: ethers.formatUnits(assetUsdc, 6),
                      amountReceived: '0',
                      error: tradeResult.error || 'Trade failed',
                    });
                    failed++;
                  }
                } else {
                  trades.push({
                    asset: assetName,
                    amountUsdc: ethers.formatUnits(assetUsdc, 6),
                    amountReceived: '0',
                    error: 'SecureAgentSigner unavailable',
                  });
                  skipped++;
                }
              } catch (tradeErr) {
                const errStr = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
                trades.push({
                  asset: assetName,
                  amountUsdc: ethers.formatUnits(assetUsdc, 6),
                  amountReceived: '0',
                  error: errStr,
                });
                failed++;
                logger.error(`[CommunityPool Cron] Trade failed for ${assetName}`, { error: errStr });
              }
            }
            
            rebalanceTrades = { executed, failed, skipped, trades };
            logger.info('[CommunityPool Cron] Rebalance trades complete', { executed, failed, skipped });
          } else {
            logger.info('[CommunityPool Cron] Allocatable USDC below threshold after reserve', {
              usdcBalance: ethers.formatUnits(usdcBalance, 6),
              reserve: ethers.formatUnits(reserveUsdc, 6),
              allocatable: ethers.formatUnits(allocatableUsdc, 6),
            });
          }
        } else if (routerAddr === ethers.ZeroAddress) {
          logger.warn('[CommunityPool Cron] DEX router not configured — cannot execute trades');
        } else {
          logger.info('[CommunityPool Cron] No significant USDC to allocate', {
            usdcBalance: ethers.formatUnits(usdcBalance, 6),
          });
        }
      } catch (tradeError) {
        logger.error('[CommunityPool Cron] Trade execution step failed', {
          error: tradeError instanceof Error ? tradeError.message : String(tradeError),
        });
      }
    }

    // Step 3.6: Log AI decision to database (always log, even HOLD decisions)
    try {
      const decisionId = `ai_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      await addPoolTransactionToDb({
        id: decisionId,
        type: 'AI_DECISION',
        chain: 'cronos',
        details: {
          action: aiDecision.action,
          reasoning: aiDecision.reasoning,
          executed: aiDecision.executed,
          txHash: aiDecision.txHash || null,
          riskScore: riskAssessment.riskScore,
          drawdownPercent: riskAssessment.drawdownPercent,
          volatility: riskAssessment.volatility,
          allocations: poolStats.allocations,
          priceValidation,
          rebalanceTrades: rebalanceTrades ?? null,
        },
        txHash: aiDecision.txHash,
      });
      
      // Update pool state with last AI decision
      if (aiDecision.action !== 'HOLD' || riskAssessment.riskScore >= 3) {
        const navUSD = Number(poolStats.totalNAV) || 0;
        const sharePriceNum = Number(poolStats.sharePrice) || 0;
        const totalSharesNum = Number(ethers.formatUnits(stats._totalShares, 18)) || 0;
        await savePoolStateToDb({
          totalValueUSD: navUSD,
          totalShares: totalSharesNum,
          sharePrice: sharePriceNum,
          allocations: Object.entries(poolStats.allocations).reduce((acc, [key, pct]) => {
            acc[key] = { percentage: pct, valueUSD: navUSD * (pct / 100), amount: 0, price: 0 };
            return acc;
          }, {} as Record<string, { percentage: number; valueUSD: number; amount: number; price: number }>),
          lastRebalance: Date.now(),
          lastAIDecision: {
            timestamp: Date.now(),
            reasoning: aiDecision.reasoning,
            allocations: poolStats.allocations,
          },
          chain: 'cronos',
        });
      }
      
      logger.info('[CommunityPool Cron] AI decision logged to database', { 
        id: decisionId, 
        action: aiDecision.action 
      });
    } catch (logError) {
      logger.warn('[CommunityPool Cron] Failed to log AI decision to DB (non-critical)', { error: logError });
    }
    
    // Step 4: Count hedges executed by AutoHedgingService
    const hedgesExecuted = riskAssessment.recommendations.filter(r => r.confidence >= 0.7).length;
    
    const result: CronResult = {
      success: true,
      poolStats,
      riskAssessment: {
        riskScore: riskAssessment.riskScore,
        drawdownPercent: riskAssessment.drawdownPercent,
        volatility: riskAssessment.volatility,
        recommendations: riskAssessment.recommendations.length,
      },
      aiDecision,
      hedgesExecuted,
      rebalanceTrades,
      priceValidation,
      signerStatus,
      agentStatus,
      duration: Date.now() - startTime,
    };
    
    logger.info('[CommunityPool Cron] Completed successfully', { 
      success: result.success,
      duration: result.duration,
      hedgesExecuted: result.hedgesExecuted,
      tradesExecuted: rebalanceTrades?.executed ?? 0,
      riskScore: result.riskAssessment?.riskScore,
      activeAgents: agentStatus.active,
    });
    
    return NextResponse.json(result);
    
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[CommunityPool Cron] Fatal error:', { error: errorMessage });
    
    return safeErrorResponse(error, 'Community pool cron') as NextResponse<CronResult>;
  }
}

/**
 * Manual trigger for testing (POST)
 */
export async function POST(request: NextRequest): Promise<NextResponse<CronResult>> {
  logger.info('[CommunityPool Cron] Manual trigger via POST');
  return GET(request);
}
