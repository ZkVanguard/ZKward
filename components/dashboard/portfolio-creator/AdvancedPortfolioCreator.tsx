'use client';

import { useState, useEffect } from 'react';
import { useSignMessage } from '@/lib/evm-wallet/hooks';
import { useWallet } from '@/lib/hooks/useWallet';
import { useCreatePortfolio } from '../../../lib/contracts/hooks';
import { useRWAManager } from '../../../lib/contracts/suiHooks';
import { CheckCircle, XCircle, Sparkles, Lock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { logger } from '../../../lib/utils/logger';
import type { StrategyConfig, AssetFilter, AIPreset, AdvancedPortfolioCreatorProps } from './types';
import { presets } from './presets';
import { StrategyStep } from './StrategyStep';
import { FiltersStep } from './FiltersStep';
import { ZKProtectionStep } from './ZKProtectionStep';
import { ReviewStep } from './ReviewStep';

export function AdvancedPortfolioCreator({ isOpen, onOpenChange, hideTrigger = false }: AdvancedPortfolioCreatorProps = {}) {
  const { address, evmConnected, isSUI, suiConnected } = useWallet();
  const { createPortfolio: createEvmPortfolio, isPending: evmPending, isConfirming: evmConfirming, isConfirmed: evmConfirmed, error: evmError, hash: evmHash } = useCreatePortfolio();
  const { createPortfolio: createSuiPortfolio, loading: suiLoading, error: suiError } = useRWAManager();
  const { signMessageAsync } = useSignMessage();
  
  const isPending = isSUI ? suiLoading : evmPending;
  const isConfirming = isSUI ? false : evmConfirming;
  const isConfirmed = isSUI ? false : evmConfirmed;
  const error = isSUI ? (suiError ? new Error(suiError) : null) : evmError;
  
  const [internalShowModal, setInternalShowModal] = useState(false);
  
  const showModal = isOpen !== undefined ? isOpen : internalShowModal;
  const setShowModal = (value: boolean) => {
    if (onOpenChange) {
      onOpenChange(value);
    } else {
      setInternalShowModal(value);
    }
  };
  
  const [step, setStep] = useState<'strategy' | 'filters' | 'review' | 'zk-protection'>('strategy');
  const [strategyPrivate, setStrategyPrivate] = useState(true);
  const [zkProofGenerated, setZkProofGenerated] = useState(false);
  const [zkProofHash, setZkProofHash] = useState('');
  const [_strategySigned, setStrategySigned] = useState(false);
  const [strategySignature, setStrategySignature] = useState('');
  const [_onChainTxHash, setOnChainTxHash] = useState('');
  
  const [strategy, setStrategy] = useState<StrategyConfig>({
    name: '',
    targetYield: 1000,
    riskTolerance: 50,
    rebalanceFrequency: 'weekly',
    hedgingEnabled: true,
    maxDrawdown: 20,
    concentrationLimit: 30,
    autoApprovalEnabled: false,
    autoApprovalThreshold: 10000,
    privateStrategy: {},
  });

  const [filters, setFilters] = useState<AssetFilter>({
    minMarketCap: 1000000,
    maxVolatility: 80,
    allowedCategories: ['DeFi', 'Layer1', 'Layer2'],
    excludedAssets: [],
    minLiquidity: 500000,
  });

  const [aiPreset, setAiPreset] = useState<AIPreset>('balanced');

  useEffect(() => {
    if (aiPreset !== 'custom') {
      setStrategy(prev => ({ ...prev, ...presets[aiPreset] }));
    }
  }, [aiPreset]);

  useEffect(() => {
    if (evmHash && !isSUI) {
      setOnChainTxHash(evmHash);
      logger.info('✅ EVM Portfolio transaction submitted', { component: 'AdvancedPortfolioCreator', data: { hash: evmHash } });
    }
  }, [evmHash, isSUI]);

  const generateZKProof = async () => {
    try {
      const response = await fetch('/api/zk-proof/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario: 'portfolio_strategy',
          statement: {
            strategyName: strategy.name,
            targetYield: strategy.targetYield,
            riskTolerance: strategy.riskTolerance,
            timestamp: Date.now(),
          },
          witness: {
            privateStrategy: strategy.privateStrategy,
            filters: filters,
            secret: `${Date.now()}-${address}`.slice(0, 32),
          },
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const proofHash = data.proof?.merkle_root || `0x${Date.now().toString(16).padEnd(64, '0')}`;
        setZkProofHash(proofHash);
        
        const message = `ZKward Portfolio Strategy\n\nName: ${strategy.name}\nTarget Yield: ${strategy.targetYield / 100}%\nRisk: ${strategy.riskTolerance}\nZK Proof: ${proofHash}\nTimestamp: ${Date.now()}`;
        
        try {
          if (isSUI) {
            const encoder = new TextEncoder();
            const data = encoder.encode(message);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            setStrategySignature(hashHex);
            setStrategySigned(true);
            setZkProofGenerated(true);
          } else {
            const signature = await signMessageAsync({ message });
            setStrategySignature(signature);
            setStrategySigned(true);
            setZkProofGenerated(true);
          }
        } catch (signError) {
          logger.error('User rejected signature', signError instanceof Error ? signError : undefined, { component: 'AdvancedPortfolioCreator' });
          throw new Error('Signature required to proceed');
        }
      }
    } catch (error) {
      logger.error('ZK proof generation failed', error instanceof Error ? error : undefined, { component: 'AdvancedPortfolioCreator' });
      throw error;
    }
  };

  const handleCreate = async () => {
    try {
      const yieldBps = BigInt(strategy.targetYield);
      const risk = BigInt(strategy.riskTolerance);
      
      let portfolioId: string | undefined;
      
      if (isSUI) {
        const result = await createSuiPortfolio({
          targetYield: strategy.targetYield,
          riskTolerance: strategy.riskTolerance,
          depositAmount: BigInt(0),
        });
        
        if (result.success && result.digest) {
          portfolioId = result.digest;
          logger.info('✅ SUI Portfolio created', { component: 'AdvancedPortfolioCreator', data: { digest: result.digest } });
        } else {
          throw new Error(result.error || 'Failed to create SUI portfolio');
        }
      } else {
        createEvmPortfolio(yieldBps, risk);
        portfolioId = 'pending-evm-tx';
      }
      
      if (portfolioId) {
        const strategyResponse = await fetch('/api/portfolio/strategy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            portfolioId: portfolioId,
            strategyConfig: { ...strategy, filters },
            zkProofHash: strategyPrivate ? zkProofHash : null,
            signature: strategySignature,
            address: address,
            chainType: isSUI ? 'sui' : 'evm',
          }),
        });

        if (strategyResponse.ok) {
          const data = await strategyResponse.json();
          setOnChainTxHash(data.onChainHash);
          logger.info('✅ Portfolio and strategy committed on-chain', { component: 'AdvancedPortfolioCreator', data });
        }
      }
    } catch (err) {
      logger.error('Failed to create portfolio', err instanceof Error ? err : undefined, { component: 'AdvancedPortfolioCreator' });
      throw err;
    }
  };

  if (!evmConnected && !suiConnected) {
    return hideTrigger ? null : (
      <button
        className="px-5 sm:px-6 py-2.5 sm:py-3 bg-[#86868b] rounded-[12px] font-semibold text-[14px] sm:text-[15px] text-white flex items-center gap-2 cursor-not-allowed"
        disabled
      >
        <Lock className="w-4 h-4 sm:w-5 sm:h-5" />
        Connect Wallet to Create Portfolio
      </button>
    );
  }

  return (
    <>
      {!hideTrigger && (
        <button
          onClick={() => setShowModal(true)}
          className="px-5 sm:px-6 py-2.5 sm:py-3 bg-[#007AFF] hover:bg-[#0051D5] active:scale-[0.98] rounded-[12px] font-semibold text-[14px] sm:text-[15px] text-white transition-all flex items-center gap-2"
        >
          <Sparkles className="w-4 h-4 sm:w-5 sm:h-5" />
          Create AI-Managed Portfolio
        </button>
      )}

      <AnimatePresence>
        {showModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => !isPending && !isConfirming && setShowModal(false)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-white rounded-[20px] sm:rounded-[24px] border border-black/5 max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)]"
            >
              {/* Header */}
              <div className="sticky top-0 bg-white border-b border-black/5 px-5 sm:px-6 py-4 sm:py-5 z-10">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-[20px] sm:text-[24px] font-semibold text-[#1d1d1f] tracking-[-0.01em] flex items-center gap-2.5">
                      <div className="w-8 h-8 sm:w-9 sm:h-9 bg-gradient-to-br from-[#AF52DE] to-[#5856D6] rounded-[10px] flex items-center justify-center">
                        <Sparkles className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
                      </div>
                      AI Fund Manager Setup
                    </h2>
                    <p className="text-[12px] sm:text-[13px] text-[#86868b] mt-1">
                      Create ZK-protected portfolio with custom strategy
                    </p>
                  </div>
                  {!isPending && !isConfirming && (
                    <button
                      onClick={() => setShowModal(false)}
                      className="p-2 text-[#86868b] hover:text-[#1d1d1f] hover:bg-[#f5f5f7] rounded-full transition-all"
                    >
                      <XCircle className="w-5 h-5 sm:w-6 sm:h-6" />
                    </button>
                  )}
                </div>

                {/* Progress Steps */}
                <div className="flex items-center gap-2 mt-5 sm:mt-6">
                  {['strategy', 'filters', 'zk-protection', 'review'].map((s, i) => (
                    <div key={s} className="flex items-center flex-1">
                      <div className={`flex-1 h-1 sm:h-1.5 rounded-full transition-colors ${
                        ['strategy', 'filters', 'zk-protection', 'review'].indexOf(step) >= i
                          ? 'bg-[#007AFF]'
                          : 'bg-[#e8e8ed]'
                      }`} />
                    </div>
                  ))}
                </div>
              </div>

              {/* Content */}
              <div className="px-5 sm:px-6 py-4 sm:py-5">
                {isConfirmed ? (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-center py-10 sm:py-12"
                  >
                    <div className="w-16 h-16 sm:w-20 sm:h-20 mx-auto mb-4 bg-[#34C759]/10 rounded-full flex items-center justify-center">
                      <CheckCircle className="w-8 h-8 sm:w-10 sm:h-10 text-[#34C759]" />
                    </div>
                    <h3 className="text-[20px] sm:text-[24px] font-semibold text-[#1d1d1f] mb-2">Portfolio Created!</h3>
                    <p className="text-[14px] sm:text-[15px] text-[#86868b] mb-6">
                      Your AI-managed portfolio is now active with ZK-protected strategy
                    </p>
                    <button
                      onClick={() => {
                        setShowModal(false);
                        window.location.reload();
                      }}
                      className="px-6 py-3 bg-[#34C759] hover:bg-[#2DB550] active:scale-[0.98] rounded-[12px] font-semibold text-[15px] text-white transition-all"
                    >
                      View Dashboard
                    </button>
                  </motion.div>
                ) : error ? (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-center py-10 sm:py-12"
                  >
                    <div className="w-16 h-16 sm:w-20 sm:h-20 mx-auto mb-4 bg-[#FF3B30]/10 rounded-full flex items-center justify-center">
                      <XCircle className="w-8 h-8 sm:w-10 sm:h-10 text-[#FF3B30]" />
                    </div>
                    <h3 className="text-[20px] sm:text-[24px] font-semibold text-[#1d1d1f] mb-2">Creation Failed</h3>
                    <p className="text-[14px] sm:text-[15px] text-[#86868b] mb-6">
                      {error.message || 'Failed to create portfolio'}
                    </p>
                    <button
                      onClick={() => setStep('strategy')}
                      className="px-6 py-3 bg-[#FF3B30] hover:bg-[#E0352B] active:scale-[0.98] rounded-[12px] font-semibold text-[15px] text-white transition-all"
                    >
                      Try Again
                    </button>
                  </motion.div>
                ) : step === 'strategy' ? (
                  <StrategyStep
                    strategy={strategy}
                    setStrategy={setStrategy}
                    aiPreset={aiPreset}
                    setAiPreset={setAiPreset}
                    onNext={() => setStep('filters')}
                  />
                ) : step === 'filters' ? (
                  <FiltersStep
                    filters={filters}
                    setFilters={setFilters}
                    onNext={() => setStep('zk-protection')}
                    onBack={() => setStep('strategy')}
                  />
                ) : step === 'zk-protection' ? (
                  <ZKProtectionStep
                    strategyPrivate={strategyPrivate}
                    setStrategyPrivate={setStrategyPrivate}
                    zkProofGenerated={zkProofGenerated}
                    onGenerateProof={generateZKProof}
                    onNext={() => setStep('review')}
                    onBack={() => setStep('filters')}
                  />
                ) : (
                  <ReviewStep
                    strategy={strategy}
                    filters={filters}
                    strategyPrivate={strategyPrivate}
                    zkProofGenerated={zkProofGenerated}
                    isPending={isPending}
                    isConfirming={isConfirming}
                    onCreate={handleCreate}
                    onBack={() => setStep('zk-protection')}
                  />
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
