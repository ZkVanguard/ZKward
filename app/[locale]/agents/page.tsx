'use client';

import { useState } from 'react';
import {
  Brain, TrendingUp, Shield, Zap, FileText,
  Eye, Layers, CheckCircle, ChevronDown,
} from 'lucide-react';
import { AgentLiveChat } from '@/components/agents/AgentLiveChat';

interface AgentSpec {
  id: string;
  name: string;
  icon: typeof Brain;
  role: string;
  description: string;
  capabilities: string[];
  implementation: string;
  api?: string;
}

const AGENTS: AgentSpec[] = [
  {
    id: 'lead',
    name: 'Lead',
    icon: Brain,
    role: 'The dispatcher',
    description: 'Reads what you asked, figures out who should handle it, and stitches the pieces back into one answer.',
    capabilities: [
      'Natural language intent parsing',
      'Routes to the right specialist',
      'Merges results into one reply',
      'Coordinates multi-agent calls',
    ],
    implementation: 'agents/core/LeadAgent.ts',
  },
  {
    id: 'risk',
    name: 'Risk',
    icon: TrendingUp,
    role: 'The worrier',
    description: 'Watches how much of the pool is at risk, flags positions that are getting close to liquidation, and scores overall portfolio health.',
    capabilities: [
      'Value at Risk (VaR) calculation',
      'Volatility and Sharpe ratio',
      'Liquidation distance per position',
      'Portfolio health score, 0 to 100',
    ],
    implementation: 'agents/specialized/RiskAgent.ts',
    api: 'POST /api/agents/risk/assess',
  },
  {
    id: 'hedging',
    name: 'Hedging',
    icon: Shield,
    role: 'The insurance broker',
    description: 'When Risk flags something, Hedging picks the counter-trade that offsets it. Short size, leverage, and asset all confidence-scored before anything opens.',
    capabilities: [
      'Short position sizing',
      'Options strategy generation',
      'Cross-asset correlation analysis',
      'Every strategy tagged with a confidence score',
    ],
    implementation: 'agents/specialized/HedgingAgent.ts',
    api: 'POST /api/agents/hedging/recommend',
  },
  {
    id: 'settlement',
    name: 'Settlement',
    icon: Zap,
    role: 'The signer',
    description: 'Turns a decision into an on-chain transaction. Batches where it can to save gas, produces the ZK proof, and knows how to unwind if something fails.',
    capabilities: [
      'Batch transaction processing',
      'Gas optimization, typically 20 to 40 percent',
      'ZK-STARK proof coordination',
      'Rollback and retry on failure',
    ],
    implementation: 'agents/specialized/SettlementAgent.ts',
    api: 'POST /api/agents/settlement/execute',
  },
  {
    id: 'reporting',
    name: 'Reporting',
    icon: FileText,
    role: 'The bookkeeper',
    description: 'Compiles the plain-English summary of what happened. Runs daily, weekly, monthly, and on-demand for the audit trail.',
    capabilities: [
      'Daily, weekly, and monthly reports',
      'Performance and P&L tracking',
      'Top positions analysis',
      'Historical trend detection',
    ],
    implementation: 'agents/specialized/ReportingAgent.ts',
    api: 'POST /api/agents/reporting/generate',
  },
  {
    id: 'priceMonitor',
    name: 'Price Monitor',
    icon: Eye,
    role: 'The lookout',
    description: 'Watches the 5-minute prediction-market ticker across BTC, ETH, SUI, and CRO. When a signal flips, it broadcasts inside seconds so the others can react.',
    capabilities: [
      'BTC, ETH, SUI, CRO threshold watch',
      'Polymarket 5-min event stream',
      'Fires on signal flip',
      'Per-asset alert routing',
    ],
    implementation: 'agents/specialized/PriceMonitorAgent.ts',
    api: 'GET /api/predictions/per-asset',
  },
  {
    id: 'suiPool',
    name: 'SUI Pool',
    icon: Layers,
    role: 'The pool operator',
    description: 'Runs the SUI USDC community pool. Reads the fused signal, picks the allocation across four assets, rebalances via BlueFin, and never lets anyone bypass the on-chain safety guards.',
    capabilities: [
      'Four-asset allocation across BTC, ETH, SUI, CRO',
      'BlueFin aggregator rebalance',
      'SafeExecutionGuard enforcement',
      'Rebalances only when AI confidence clears 65 percent',
    ],
    implementation: 'agents/specialized/SuiPoolAgent.ts',
    api: 'GET /api/sui/community-pool',
  },
];

export default function AgentsPage() {
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  return (
    <div className="bg-system-bg-primary text-label-primary min-h-screen">
      <div className="max-w-[900px] mx-auto px-4 sm:px-6 pt-20 pb-16 sm:pt-24 space-y-6">
        {/* Compact header */}
        <header className="text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-ios-green/10 text-[#0F5132] text-caption-1 font-medium mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-ios-green" />
            Seven agents, live, read-only
          </div>
          <h1 className="font-display font-semibold text-title-1 sm:text-[44px] tracking-[-0.03em] leading-tight text-label-primary mb-2">
            Ask ZKward.
          </h1>
          <p className="text-callout text-label-secondary max-w-[560px] mx-auto leading-relaxed">
            Talk to the vault. Every answer reads live state from the same tools the agents use. Nothing rehearsed.
          </p>
        </header>

        {/* Chat is the main component */}
        <AgentLiveChat />

        {/* Compact agent list — expandable rows */}
        <section className="pt-4">
          <h2 className="text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-3">
            Meet the crew
          </h2>
          <div className="space-y-2">
            {AGENTS.map((agent) => {
              const Icon = agent.icon;
              const isExpanded = expandedAgent === agent.id;
              return (
                <div
                  key={agent.id}
                  className="rounded-ios border border-separator-opaque/30 bg-system-bg-primary overflow-hidden"
                >
                  <button
                    onClick={() => setExpandedAgent(isExpanded ? null : agent.id)}
                    className="w-full flex items-center gap-3 p-3 text-left hover:bg-system-bg-secondary/50 transition-colors"
                  >
                    <div className="w-8 h-8 rounded-ios bg-ios-blue/10 text-ios-blue flex items-center justify-center flex-shrink-0">
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-callout font-semibold text-label-primary truncate">
                        {agent.name}
                      </div>
                      <div className="text-caption-1 text-label-tertiary truncate">
                        {agent.role}
                      </div>
                    </div>
                    <ChevronDown
                      className={`w-4 h-4 text-label-tertiary flex-shrink-0 transition-transform ${
                        isExpanded ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-3 pt-1 border-t border-separator-opaque/20 space-y-3">
                      <p className="text-footnote text-label-secondary leading-relaxed">
                        {agent.description}
                      </p>
                      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {agent.capabilities.map((c) => (
                          <li key={c} className="flex items-start gap-1.5 text-caption-1 text-label-primary">
                            <CheckCircle className="w-3 h-3 text-ios-blue mt-0.5 flex-shrink-0" strokeWidth={2.5} />
                            <span>{c}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="flex flex-wrap gap-2 text-caption-1 font-mono">
                        <a
                          href={`https://github.com/ZkVanguard/ZkWard/blob/main/${agent.implementation}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-ios-blue hover:underline break-all"
                        >
                          {agent.implementation} ↗
                        </a>
                        {agent.api && (
                          <span className="text-label-tertiary">· {agent.api}</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Architecture — collapsible */}
        <details className="group rounded-ios border border-separator-opaque/30 bg-system-bg-primary">
          <summary className="flex items-center gap-2 p-3 cursor-pointer hover:bg-system-bg-secondary/50 transition-colors list-none">
            <span className="text-callout font-semibold text-label-primary flex-1">Architecture</span>
            <ChevronDown className="w-4 h-4 text-label-tertiary group-open:rotate-180 transition-transform" />
          </summary>
          <div className="px-3 pb-3 pt-1 border-t border-separator-opaque/20 space-y-3">
            <p className="text-footnote text-label-secondary leading-relaxed">
              All agents talk through a central <span className="font-mono text-label-primary">MessageBus</span> and extend a common <span className="font-mono text-label-primary">BaseAgent</span>. Each concern owns one file. Nothing shares state through globals.
            </p>
            <pre className="text-caption-1 bg-label-primary text-white p-3 rounded-ios overflow-x-auto font-mono leading-relaxed">
{`User Input → Lead Agent (parse intent)
    ↓
MessageBus (route to specialized agents)
    ↓
Risk / Hedging / Settlement / Reporting (execute)
    ↓
MessageBus (return results)
    ↓
Lead Agent (aggregate + respond)`}
            </pre>
          </div>
        </details>
      </div>
    </div>
  );
}
