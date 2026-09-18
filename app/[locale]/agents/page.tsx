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
    name: 'Lead Agent',
    icon: Brain,
    role: 'Orchestrator',
    description: 'Central coordinator that parses user intent, delegates tasks to specialized agents, and aggregates results.',
    capabilities: [
      'Natural language intent parsing',
      'Task delegation and routing',
      'Result aggregation',
      'Inter-agent coordination',
    ],
    implementation: 'agents/core/LeadAgent.ts',
  },
  {
    id: 'risk',
    name: 'Risk Agent',
    icon: TrendingUp,
    role: 'Risk Analyzer',
    description: 'Portfolio risk analysis: VaR, volatility, exposure, health scoring.',
    capabilities: [
      'Value at Risk (VaR) calculation',
      'Volatility + Sharpe',
      'Liquidation-risk assessment',
      'Portfolio health scoring (0-100)',
    ],
    implementation: 'agents/specialized/RiskAgent.ts',
    api: 'POST /api/agents/risk/assess',
  },
  {
    id: 'hedging',
    name: 'Hedging Agent',
    icon: Shield,
    role: 'Strategy Generator',
    description: 'Generates optimal hedging strategies based on risk, market, and portfolio composition.',
    capabilities: [
      'Short position recommendations',
      'Options strategy generation',
      'Cross-asset correlation analysis',
      'Confidence-scored strategies',
    ],
    implementation: 'agents/specialized/HedgingAgent.ts',
    api: 'POST /api/agents/hedging/recommend',
  },
  {
    id: 'settlement',
    name: 'Settlement Agent',
    icon: Zap,
    role: 'Transaction Executor',
    description: 'Batch settlements with ZK proof generation for gas + privacy.',
    capabilities: [
      'Batch transaction processing',
      'Gas optimization (20-40%)',
      'ZK-STARK proof coordination',
      'Rollback and retry',
    ],
    implementation: 'agents/specialized/SettlementAgent.ts',
    api: 'POST /api/agents/settlement/execute',
  },
  {
    id: 'reporting',
    name: 'Reporting Agent',
    icon: FileText,
    role: 'Analytics Generator',
    description: 'Comprehensive performance reports + compliance metrics.',
    capabilities: [
      'Daily / weekly / monthly reports',
      'Performance + P&L tracking',
      'Top positions analysis',
      'Historical trend analysis',
    ],
    implementation: 'agents/specialized/ReportingAgent.ts',
    api: 'POST /api/agents/reporting/generate',
  },
  {
    id: 'priceMonitor',
    name: 'Price Monitor Agent',
    icon: Eye,
    role: 'Threshold Watcher',
    description: 'Subscribes to the 5-min Polymarket signal ticker and broadcasts flip alerts.',
    capabilities: [
      'BTC / ETH / SUI / CRO threshold watch',
      'Polymarket5MinService event stream',
      'Trigger on signal-flip',
      'Per-asset alert routing',
    ],
    implementation: 'agents/specialized/PriceMonitorAgent.ts',
    api: 'GET /api/predictions/per-asset',
  },
  {
    id: 'suiPool',
    name: 'SUI Pool Agent',
    icon: Layers,
    role: 'On-chain Pool Manager',
    description: 'Drives the SUI USDC community pool: allocation, rebalance, hedge sizing, guard enforcement.',
    capabilities: [
      '4-asset allocation (BTC / ETH / SUI / CRO)',
      'BlueFin Aggregator rebalance',
      'SafeExecutionGuard enforcement',
      'AI-confidence-gated rebalance (≥65%)',
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
            7 agents live · read-only
          </div>
          <h1 className="font-display font-semibold text-title-1 sm:text-[44px] tracking-[-0.03em] leading-tight text-label-primary mb-2">
            Ask ZkWard
          </h1>
          <p className="text-callout text-label-secondary max-w-[560px] mx-auto leading-relaxed">
            Talk to the status oracle. Every answer is grounded in live DB state via the same tools the Layer 3 agents use.
          </p>
        </header>

        {/* Chat is the main component */}
        <AgentLiveChat />

        {/* Compact agent list — expandable rows */}
        <section className="pt-4">
          <h2 className="text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-3">
            The 7 agents
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
              All agents communicate through a central <span className="font-mono text-label-primary">MessageBus</span> and extend a common <span className="font-mono text-label-primary">BaseAgent</span>. Each concern owns one file.
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
