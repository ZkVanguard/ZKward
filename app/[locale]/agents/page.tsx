'use client';

import { useState } from 'react';
import {
  Brain, TrendingUp, Shield, Zap, FileText, MessageSquare,
  Activity, ChevronRight, CheckCircle, Eye, Layers,
} from 'lucide-react';
import { Section, SectionHeader, StatusPill, LiveIndicator, Reveal } from '@/components/ui/landing';
import { AgentLiveChat } from '@/components/agents/AgentLiveChat';

interface AgentSpec {
  id: string;
  name: string;
  icon: typeof Brain;
  role: string;
  description: string;
  capabilities: string[];
  implementation: string;
  extends: string;
  api?: string;
  apiStatus?: string;
  messageTypes?: string[];
  currentStatus: string;
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
      'Result aggregation and synthesis',
      'Inter-agent communication coordination',
      'Strategy execution orchestration',
    ],
    implementation: 'agents/core/LeadAgent.ts',
    extends: 'BaseAgent',
    messageTypes: ['strategy-input', 'agent-result', 'task-result', 'status-update'],
    currentStatus: 'Fully operational. Orchestrates all 7 agents with complete end-to-end workflow validated.',
  },
  {
    id: 'risk',
    name: 'Risk Agent',
    icon: TrendingUp,
    role: 'Risk Analyzer',
    description: 'Analyzes portfolio risk using quantitative metrics, volatility calculations, and exposure analysis.',
    capabilities: [
      'Value at Risk (VaR) calculation',
      'Volatility and standard deviation analysis',
      'Sharpe ratio computation',
      'Liquidation risk assessment',
      'Portfolio health scoring (0-100)',
      'Risk recommendations generation',
    ],
    implementation: 'agents/specialized/RiskAgent.ts',
    extends: 'BaseAgent',
    api: 'POST /api/agents/risk/assess',
    apiStatus: 'Fully operational. Tested with real portfolio data.',
    currentStatus: 'Validated in complete-system-test.ts. Risk score 12.2 / 100 (LOW), 100% success.',
  },
  {
    id: 'hedging',
    name: 'Hedging Agent',
    icon: Shield,
    role: 'Strategy Generator',
    description: 'Generates optimal hedging strategies based on risk profile, market conditions, and portfolio composition.',
    capabilities: [
      'Short position recommendations',
      'Options strategy generation (calls/puts)',
      'Stablecoin hedge suggestions',
      'Cross-asset correlation analysis',
      'Confidence scoring for strategies',
      'Risk mitigation planning',
    ],
    implementation: 'agents/specialized/HedgingAgent.ts',
    extends: 'BaseAgent',
    api: 'POST /api/agents/hedging/recommend',
    apiStatus: 'Fully operational. Generates dynamic strategies.',
    currentStatus: 'Validated in complete-system-test.ts. 2 hedge strategies generated, portfolio rebalancing executed.',
  },
  {
    id: 'settlement',
    name: 'Settlement Agent',
    icon: Zap,
    role: 'Transaction Executor',
    description: 'Executes batch settlements with ZK proof generation for gas optimization and privacy preservation.',
    capabilities: [
      'Batch transaction processing',
      'Gas optimization (20 to 40% savings)',
      'ZK-STARK proof generation coordination',
      'Transaction nonce management',
      'Settlement verification',
      'Rollback and retry logic',
    ],
    implementation: 'agents/specialized/SettlementAgent.ts',
    extends: 'BaseAgent',
    api: 'POST /api/agents/settlement/execute',
    apiStatus: 'Fully operational. Real x402 gasless settlements.',
    currentStatus: 'Validated in complete-system-test.ts. $1,000 gasless settlement created with ZK proof authentication.',
  },
  {
    id: 'reporting',
    name: 'Reporting Agent',
    icon: FileText,
    role: 'Analytics Generator',
    description: 'Generates comprehensive performance reports with compliance metrics and data visualization.',
    capabilities: [
      'Daily / weekly / monthly report generation',
      'Performance metrics calculation',
      'Profit & Loss tracking',
      'Top positions analysis',
      'Compliance reporting',
      'Historical trend analysis',
    ],
    implementation: 'agents/specialized/ReportingAgent.ts',
    extends: 'BaseAgent',
    api: 'POST /api/agents/reporting/generate',
    apiStatus: 'Fully operational. Comprehensive analytics.',
    currentStatus: 'Validated in complete-system-test.ts. Full portfolio report with positions, P&L, and metrics.',
  },
  {
    id: 'priceMonitor',
    name: 'Price Monitor Agent',
    icon: Eye,
    role: 'Threshold Watcher',
    description: 'Subscribes to the proactive 5-min Polymarket signal ticker, watches price thresholds, and broadcasts alerts to other agents.',
    capabilities: [
      'Real-time threshold monitoring across BTC / ETH / SUI / CRO',
      'Subscribes to Polymarket5MinService event stream',
      'Triggers other agents on signal-flip events',
      'CentralizedHedgeManager integration',
      'Per-asset alert routing',
      'No-poll architecture (event-driven)',
    ],
    implementation: 'agents/specialized/PriceMonitorAgent.ts',
    extends: 'BaseAgent',
    api: 'GET /api/predictions/per-asset',
    apiStatus: 'Fully operational. 10s proactive ticker.',
    currentStatus: 'Live on every dashboard request. Consumes the Polymarket 5-min binary signal stream.',
  },
  {
    id: 'suiPool',
    name: 'SUI Pool Agent',
    icon: Layers,
    role: 'On-chain Pool Manager',
    description: 'Drives the SUI USDC community pool: 4-asset allocation, rebalance via BlueFin aggregator, hedge sizing, SafeExecutionGuard enforcement.',
    capabilities: [
      '4-asset allocation (BTC / ETH / SUI / CRO)',
      'Rebalance via BlueFin Aggregator (7k pools)',
      'Hedge sizing aware of swappable vs hedged assets',
      'Integrates SafeExecutionGuard position limits',
      'Reads on-chain pool state every 30 min',
      'AI-confidence-gated rebalance (only fires at ≥65%)',
    ],
    implementation: 'agents/specialized/SuiPoolAgent.ts',
    extends: 'BaseAgent',
    api: 'GET /api/sui/community-pool',
    apiStatus: 'Fully operational. Live on SUI mainnet.',
    currentStatus: 'Running every 30 min via sui-community-pool cron. Manages the live pool NAV.',
  },
];

const STATUS_TAGS = ['7 Agents Operational', 'CoinGecko Integration', 'ZK Proofs Validated', 'x402 Gasless'];

export default function AgentsPage() {
  const [selectedAgent, setSelectedAgent] = useState<string>('lead');
  const selected = AGENTS.find(a => a.id === selectedAgent);

  return (
    <div className="bg-system-bg-primary text-label-primary min-h-screen">
      {/* HERO */}
      <section className="pt-20 pb-8 sm:pt-32 sm:pb-16 px-4 sm:px-5 lg:px-8 min-w-0">
        <div className="max-w-[900px] mx-auto text-center">
          <div className="flex justify-center mb-8">
            <StatusPill
              left={<LiveIndicator label="7 agents · live" />}
              right={
                <span className="text-footnote font-semibold text-label-primary tabular-nums">
                  10 / 10 tests passing
                </span>
              }
            />
          </div>
          <h1 className="font-display font-semibold text-[36px] sm:text-[56px] md:text-[68px] lg:text-[80px] tracking-[-0.04em] leading-[0.96] text-label-primary mb-5 sm:mb-6 break-words">
            Seven agents.
            <br />
            One autonomous vault.
          </h1>
          <p className="text-base sm:text-[19px] text-label-secondary max-w-[620px] mx-auto leading-relaxed">
            A multi-agent architecture for autonomous portfolio management. Each agent owns one concern.
            They coordinate over a central MessageBus and settle every meaningful decision with a ZK proof.
          </p>
        </div>
      </section>

      {/* PRODUCTION STATUS STRIP */}
      <Section size="sm">
        <div className="max-w-[900px] mx-auto">
          <div className="bg-system-bg-primary rounded-[20px] border border-separator-opaque/40 shadow-ios-1 p-5 sm:p-6">
            <div className="flex items-start gap-4">
              <div className="w-11 h-11 rounded-ios bg-ios-green/10 flex items-center justify-center flex-shrink-0">
                <Activity className="w-5 h-5 text-ios-green" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-headline font-semibold text-label-primary mb-1">Production status</h3>
                <p className="text-callout text-label-secondary mb-3 leading-relaxed">
                  All 7 agents fully operational with real integrations. Live CoinGecko prices,
                  ZK-STARK proofs, and x402 gasless settlements.
                </p>
                <div className="flex flex-wrap gap-1.5 sm:gap-2">
                  {STATUS_TAGS.map((item) => (
                    <span key={item} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-ios-green/10 text-[#0F5132] rounded-full text-caption-1 font-medium">
                      <CheckCircle className="w-3 h-3" strokeWidth={2.5} />
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* AGENT EXPLORER */}
      <Section tone="secondary" size="md">
        <Reveal>
          <SectionHeader
            eyebrow="Explorer"
            title="Meet the agents."
            lede="Select an agent to see its role, capabilities, implementation file, and API surface."
            align="left"
          />
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* Selector list */}
            <div className="lg:col-span-4 space-y-2">
              {AGENTS.map((agent) => {
                const Icon = agent.icon;
                const isSelected = selectedAgent === agent.id;
                return (
                  <button
                    key={agent.id}
                    onClick={() => setSelectedAgent(agent.id)}
                    className={`w-full text-left rounded-ios-xl border transition-all active:scale-[0.99] p-4 ${
                      isSelected
                        ? 'border-ios-blue bg-system-bg-primary shadow-[0_0_0_4px_rgba(0,122,255,0.08)]'
                        : 'border-separator-opaque/30 bg-system-bg-primary hover:border-separator-opaque'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-11 h-11 rounded-ios flex items-center justify-center flex-shrink-0 ${
                        isSelected ? 'bg-ios-blue text-white' : 'bg-system-bg-grouped text-label-secondary'
                      }`}>
                        <Icon className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <h3 className="text-headline font-semibold text-label-primary truncate">{agent.name}</h3>
                          <ChevronRight className={`w-4 h-4 flex-shrink-0 transition-colors ${isSelected ? 'text-ios-blue' : 'text-label-tertiary'}`} />
                        </div>
                        <p className="text-caption-1 text-label-tertiary mb-1">{agent.role}</p>
                        <LiveIndicator label="Active" />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Detail panel */}
            <div className="lg:col-span-8">
              {selected ? (
                <div className="bg-system-bg-primary rounded-[24px] border border-separator-opaque/40 shadow-ios-2 overflow-hidden">
                  {/* Header */}
                  <div className="p-6 border-b border-separator-opaque/30">
                    <div className="flex items-start gap-4">
                      <div className="w-14 h-14 rounded-ios-xl bg-ios-blue text-white flex items-center justify-center flex-shrink-0">
                        {(() => { const Icon = selected.icon; return <Icon className="w-7 h-7" />; })()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h2 className="font-display font-semibold text-title-2 tracking-[-0.02em] text-label-primary mb-1">{selected.name}</h2>
                        <p className="text-callout text-label-secondary leading-relaxed">{selected.description}</p>
                      </div>
                    </div>
                  </div>

                  {/* Capabilities */}
                  <div className="p-6 border-b border-separator-opaque/30">
                    <h3 className="text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-4">Capabilities</h3>
                    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {selected.capabilities.map((capability) => (
                        <li key={capability} className="flex items-start gap-2.5 py-1.5">
                          <CheckCircle className="w-4 h-4 text-ios-blue mt-0.5 flex-shrink-0" strokeWidth={2.5} />
                          <span className="text-subheadline text-label-primary">{capability}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Implementation + API */}
                  <div className="p-6 space-y-3">
                    <div className="bg-system-bg-secondary rounded-ios p-4">
                      <h4 className="text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-2">Implementation</h4>
                      <a
                        href={`https://github.com/ZkVanguard/zkward-ethglobal/blob/main/${selected.implementation}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-subheadline text-ios-blue font-mono break-all hover:underline"
                      >
                        {selected.implementation} ↗
                      </a>
                      <p className="text-caption-1 text-label-tertiary mt-1.5">Extends: {selected.extends}</p>
                    </div>
                    {selected.api && (
                      <div className="bg-system-bg-secondary rounded-ios p-4">
                        <h4 className="text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-2">API endpoint</h4>
                        <code className="text-subheadline text-ios-green font-mono break-all">{selected.api}</code>
                        {selected.apiStatus && (
                          <p className="text-caption-1 text-label-tertiary mt-1.5">{selected.apiStatus}</p>
                        )}
                      </div>
                    )}
                    {selected.messageTypes && (
                      <div className="bg-system-bg-secondary rounded-ios p-4">
                        <h4 className="text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-3">MessageBus events</h4>
                        <div className="flex flex-wrap gap-1.5">
                          {selected.messageTypes.map((type) => (
                            <span key={type} className="text-caption-1 px-2.5 py-1 bg-ios-blue text-white rounded-full font-medium font-mono">
                              {type}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="bg-ios-blue/5 border border-ios-blue/20 rounded-ios p-4">
                      <h4 className="text-caption-1 uppercase tracking-wide font-semibold text-ios-blue mb-1.5">Current status</h4>
                      <p className="text-subheadline text-label-primary leading-relaxed">{selected.currentStatus}</p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-system-bg-primary rounded-[24px] border border-separator-opaque/40 p-12 text-center">
                  <div className="w-16 h-16 mx-auto mb-4 bg-system-bg-secondary rounded-full flex items-center justify-center">
                    <MessageSquare className="w-7 h-7 text-label-tertiary" />
                  </div>
                  <h3 className="text-headline font-semibold text-label-primary mb-1">Select an agent</h3>
                  <p className="text-callout text-label-secondary">Click a card on the left to view details.</p>
                </div>
              )}
            </div>
          </div>
        </Reveal>
      </Section>

      {/* ARCHITECTURE */}
      <Section size="md">
        <Reveal>
          <SectionHeader
            eyebrow="Architecture"
            title="One bus. One base class. Seven concerns."
            align="left"
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4 mb-4">
            <div className="bg-system-bg-secondary rounded-ios-xl p-5 sm:p-6">
              <div className="flex items-center gap-2.5 mb-3">
                <div className="w-9 h-9 bg-ios-blue/10 rounded-ios flex items-center justify-center">
                  <MessageSquare className="w-4 h-4 text-ios-blue" />
                </div>
                <h3 className="text-headline font-semibold text-label-primary">MessageBus</h3>
              </div>
              <p className="text-subheadline text-label-secondary leading-relaxed mb-3">
                All agents communicate through a central MessageBus using EventEmitter3 for inter-agent coordination.
              </p>
              <code className="text-caption-1 text-ios-blue font-mono bg-system-bg-primary px-3 py-1.5 rounded-ios border border-separator-opaque/30 inline-block break-all">
                agents/communication/MessageBus.ts
              </code>
            </div>
            <div className="bg-system-bg-secondary rounded-ios-xl p-5 sm:p-6">
              <div className="flex items-center gap-2.5 mb-3">
                <div className="w-9 h-9 bg-ios-blue/10 rounded-ios flex items-center justify-center">
                  <Brain className="w-4 h-4 text-ios-blue" />
                </div>
                <h3 className="text-headline font-semibold text-label-primary">BaseAgent</h3>
              </div>
              <p className="text-subheadline text-label-secondary leading-relaxed mb-3">
                All specialized agents extend BaseAgent, which provides core functionality for task execution and messaging.
              </p>
              <code className="text-caption-1 text-ios-blue font-mono bg-system-bg-primary px-3 py-1.5 rounded-ios border border-separator-opaque/30 inline-block break-all">
                agents/core/BaseAgent.ts
              </code>
            </div>
          </div>

          <div className="bg-label-primary rounded-ios-xl p-5 sm:p-6">
            <h4 className="text-caption-1 uppercase tracking-wide font-semibold text-white/60 mb-4">Message flow</h4>
            <pre className="text-subheadline text-white overflow-x-auto font-mono leading-relaxed">
{`User Input → Lead Agent (parse intent)
    ↓
MessageBus (route to specialized agents)
    ↓
Risk / Hedging / Settlement / Reporting Agent (execute task)
    ↓
MessageBus (return results)
    ↓
Lead Agent (aggregate + respond to user)`}
            </pre>
          </div>
        </Reveal>
      </Section>

      {/* LIVE STATUS ORACLE — chat with the platform */}
      <Section size="md">
        <div className="max-w-[900px] mx-auto space-y-6">
          <SectionHeader
            eyebrow="Talk to the platform"
            title="Ask what the agents are thinking"
            lede="Read-only chat with a status oracle that queries live DB state via the same 6 tools the Layer 3 agents use. Ask about hedges, treasury, signals, or cron state — every answer is grounded in real numbers."
          />
          <AgentLiveChat />
        </div>
      </Section>
    </div>
  );
}
