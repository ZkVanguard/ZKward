/**
 * Agent Swarm Activity + Debug Logs panel.
 *
 * Extracted from simulator/page.tsx 2026-09-18. State ownership stays
 * in the parent — this component takes agentActions/logs/showLogs
 * as props.
 */
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, Zap, Terminal, Eye, EyeOff } from 'lucide-react';
import { ZKBadgeInline } from '@/components/ZKVerificationBadge';
import type { AgentAction } from '@/app/[locale]/simulator/types';
import type { RefObject } from 'react';

interface Props {
  agentActions: AgentAction[];
  logs: string[];
  showLogs: boolean;
  onToggleLogs: () => void;
  logsEndRef: RefObject<HTMLDivElement | null>;
}

export function AgentActivityPanel({ agentActions, logs, showLogs, onToggleLogs, logsEndRef }: Props) {
  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Agent Activity */}
      <div className="bg-white rounded-[16px] sm:rounded-[20px] border border-black/5 p-4 sm:p-5 shadow-sm max-h-[400px] overflow-y-auto">
        <h2 className="text-[15px] sm:text-[17px] font-semibold text-[#1d1d1f] mb-4 flex items-center gap-2">
          <div className="w-8 h-8 bg-[#5856D6]/10 rounded-[8px] flex items-center justify-center">
            <Brain className="w-4 h-4 text-[#5856D6]" />
          </div>
          Agent Swarm Activity
        </h2>

        {agentActions.length === 0 ? (
          <div className="text-center py-8">
            <div className="w-14 h-14 mx-auto mb-3 bg-[#f5f5f7] rounded-full flex items-center justify-center">
              <Brain className="w-7 h-7 text-[#86868b]" />
            </div>
            <p className="text-[14px] text-[#86868b]">
              Start simulation to see agent activity
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {agentActions.map((action) => (
              <motion.div
                key={action.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                className={`p-3 rounded-[10px] border ${
                  action.status === 'completed'
                    ? 'bg-[#34C759]/5 border-[#34C759]/20'
                    : action.status === 'executing'
                      ? 'bg-[#007AFF]/5 border-[#007AFF]/20'
                      : action.status === 'failed'
                        ? 'bg-[#FF3B30]/5 border-[#FF3B30]/20'
                        : 'bg-[#f5f5f7] border-black/5'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-[13px] sm:text-[14px] text-[#1d1d1f]">
                    {action.agent} Agent
                  </span>
                  <div className="flex items-center gap-2">
                    {action.status === 'completed' && action.zkProof && (
                      <ZKBadgeInline verified={true} />
                    )}
                    {action.status === 'executing' && (
                      <span className="text-[11px] sm:text-[12px] text-[#007AFF] animate-pulse">
                        Executing...
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-[11px] sm:text-[12px] text-[#86868b]">{action.action}</div>
                <div className="text-[11px] sm:text-[12px] text-[#86868b] mt-1">
                  {action.description}
                </div>
                {action.impact && action.status === 'completed' && (
                  <div className="text-[11px] sm:text-[12px] mt-2 flex items-center gap-2 text-[#34C759]">
                    <Zap className="w-3 h-3" />
                    {action.impact.metric}: {action.impact.before} → {action.impact.after}
                  </div>
                )}
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* Debug Logs */}
      <div className="bg-white rounded-[16px] sm:rounded-[20px] border border-black/5 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/5">
          <h3 className="text-[13px] sm:text-[14px] font-semibold text-[#1d1d1f] flex items-center gap-2">
            <Terminal className="w-4 h-4 text-[#34C759]" />
            Debug Logs
          </h3>
          <button
            onClick={onToggleLogs}
            className="text-[#86868b] hover:text-[#1d1d1f] transition-colors"
          >
            {showLogs ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>

        <AnimatePresence>
          {showLogs && (
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: 0 }}
              className="overflow-hidden"
            >
              <div className="p-4 bg-[#1d1d1f] max-h-[200px] overflow-y-auto font-mono text-[11px] sm:text-[12px]">
                {logs.length === 0 ? (
                  <span className="text-[#86868b]">Logs will appear here...</span>
                ) : (
                  logs.map((log, i) => (
                    <div key={i} className="text-[#f5f5f7] mb-1">
                      {log}
                    </div>
                  ))
                )}
                <div ref={logsEndRef} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
