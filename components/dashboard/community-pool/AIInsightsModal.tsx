'use client';

import React, { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brain, ArrowRightLeft, RefreshCw } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import type { AIRecommendation } from './types';
import { ASSET_COLORS } from './utils';

interface AIInsightsModalProps {
  isOpen: boolean;
  onClose: () => void;
  recommendation: AIRecommendation | null;
}

export const AIInsightsModal = memo(function AIInsightsModal({
  isOpen,
  onClose,
  recommendation,
}: AIInsightsModalProps) {
  // Portal target. The parent tree wraps in framer-motion's <motion.div>
  // which applies `transform`, breaking `position: fixed` for descendants
  // (they'd anchor to the transformed ancestor, not the viewport). Portal
  // to document.body so the modal always covers the viewport.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => { setPortalTarget(document.body); }, []);
  if (!portalTarget) return null;
  const modal = (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 sm:p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: 'spring', damping: 26, stiffness: 300 }}
            className="relative bg-white dark:bg-gray-800 shadow-2xl w-full max-w-2xl rounded-t-[24px] sm:rounded-2xl max-h-[92vh] sm:max-h-[80vh] overflow-auto pb-safe sm:pb-0"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Sheet-handle indicator on mobile. Sits on the gradient header */}
            <div className="sm:hidden absolute left-0 right-0 top-0 z-10 flex justify-center pt-2">
              <div className="w-9 h-1 rounded-full bg-white/60" />
            </div>

            <div className="p-4 sm:p-5 pt-6 sm:pt-5 border-b border-gray-200 dark:border-gray-700 bg-ios-blue">
              <h3 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
                <Brain className="w-5 h-5 flex-shrink-0" />
                <span className="truncate">AI Allocation Insights</span>
              </h3>
            </div>

            <div className="p-4 sm:p-5">
              {recommendation ? (
                <>
                  <div className="mb-4">
                    <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 mb-2">
                      Confidence: <span className="tabular-nums font-medium">{recommendation.confidence}%</span>
                    </p>
                    <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-green-500 to-emerald-500 transition-all"
                        style={{ width: `${recommendation.confidence}%` }}
                      />
                    </div>
                  </div>

                  <div className="prose dark:prose-invert text-xs sm:text-sm whitespace-pre-wrap mb-4 max-w-none">
                    {recommendation.reasoning}
                  </div>

                  <h4 className="font-semibold text-gray-900 dark:text-white mb-2 text-sm sm:text-base">Proposed Changes:</h4>
                  <div className="space-y-2">
                    {recommendation.changes.map((change) => (
                      <div
                        key={change.asset}
                        className="flex items-center justify-between gap-3 p-2 sm:p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50"
                      >
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <div className={`w-3 h-3 rounded-full flex-shrink-0 ${ASSET_COLORS[change.asset]}`} />
                          <span className="text-xs sm:text-sm font-medium">{change.asset}</span>
                        </div>
                        <div className="flex items-center gap-2 sm:gap-3 text-xs sm:text-sm tabular-nums flex-shrink-0">
                          <span className="text-gray-500">{change.currentPercent}%</span>
                          <ArrowRightLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-gray-400 flex-shrink-0" />
                          <span
                            className={`font-medium ${
                              change.change > 0
                                ? 'text-green-600'
                                : change.change < 0
                                ? 'text-red-600'
                                : ''
                            }`}
                          >
                            {change.proposedPercent}%
                          </span>
                          {change.change !== 0 && (
                            <span
                              className={`text-[10px] sm:text-xs ${change.change > 0 ? 'text-green-600' : 'text-red-600'}`}
                            >
                              ({change.change > 0 ? '+' : ''}
                              {change.change}%)
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="text-center py-8">
                  <RefreshCw className="w-8 h-8 text-gray-400 animate-spin mx-auto mb-2" />
                  <p className="text-gray-500 text-sm">Loading AI analysis...</p>
                </div>
              )}
            </div>

            <div className="p-4 sm:p-5 border-t border-gray-200 dark:border-gray-700 flex justify-end">
              <button
                onClick={onClose}
                className="w-full sm:w-auto h-11 sm:h-auto px-5 py-2.5 text-[15px] sm:text-sm font-medium bg-[#1d1d1f] hover:bg-[#0A0E1A] text-white active:scale-[0.98] rounded-xl transition-all"
              >
                Close
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
  return createPortal(modal, portalTarget);
});
