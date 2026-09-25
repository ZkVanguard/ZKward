'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Brain, TrendingUp, Shield, Zap, FileText,
  Eye, Layers, CheckCircle, ChevronDown,
} from 'lucide-react';
import { AgentLiveChat } from '@/components/agents/AgentLiveChat';

// Non-translated technical facts (file paths + API routes) live alongside the
// translation keys so the JSON stays user-facing content only. Order MUST match
// the visual order that used to be hardcoded here.
const AGENT_KEYS = [
  { id: 'lead',         icon: Brain,      implementation: 'agents/core/LeadAgent.ts',                            api: undefined                                       },
  { id: 'risk',         icon: TrendingUp, implementation: 'agents/specialized/RiskAgent.ts',                     api: 'POST /api/agents/risk/assess'                  },
  { id: 'hedging',      icon: Shield,     implementation: 'agents/specialized/HedgingAgent.ts',                  api: 'POST /api/agents/hedging/recommend'            },
  { id: 'settlement',   icon: Zap,        implementation: 'agents/specialized/SettlementAgent.ts',               api: 'POST /api/agents/settlement/execute'           },
  { id: 'reporting',    icon: FileText,   implementation: 'agents/specialized/ReportingAgent.ts',                api: 'POST /api/agents/reporting/generate'           },
  { id: 'priceMonitor', icon: Eye,        implementation: 'agents/specialized/PriceMonitorAgent.ts',             api: 'GET /api/predictions/per-asset'                },
  { id: 'suiPool',      icon: Layers,     implementation: 'agents/specialized/SuiPoolAgent.ts',                  api: 'GET /api/sui/community-pool'                   },
] as const;

const CAPABILITY_KEYS = ['c1', 'c2', 'c3', 'c4'] as const;

export default function AgentsPage() {
  const t = useTranslations('agentsPage');
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  return (
    <div className="bg-system-bg-primary text-label-primary min-h-screen">
      <div className="max-w-[900px] mx-auto px-4 sm:px-6 pt-20 pb-16 sm:pt-24 space-y-6">
        {/* Compact header */}
        <header className="text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-ios-green/10 text-[#0F5132] text-caption-1 font-medium mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-ios-green" />
            {t('header.badge')}
          </div>
          <h1 className="font-display font-semibold text-title-1 sm:text-[44px] tracking-[-0.03em] leading-tight text-label-primary mb-2">
            {t('header.title')}
          </h1>
          <p className="text-callout text-label-secondary max-w-[560px] mx-auto leading-relaxed">
            {t('header.subtitle')}
          </p>
        </header>

        {/* Chat is the main component */}
        <AgentLiveChat />

        {/* Compact agent list — expandable rows */}
        <section className="pt-4">
          <h2 className="text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-3">
            {t('meetTheCrew')}
          </h2>
          <div className="space-y-2">
            {AGENT_KEYS.map((agent) => {
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
                        {t(`agents.${agent.id}.name`)}
                      </div>
                      <div className="text-caption-1 text-label-tertiary truncate">
                        {t(`agents.${agent.id}.role`)}
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
                        {t(`agents.${agent.id}.description`)}
                      </p>
                      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {CAPABILITY_KEYS.map((c) => (
                          <li key={c} className="flex items-start gap-1.5 text-caption-1 text-label-primary">
                            <CheckCircle className="w-3 h-3 text-ios-blue mt-0.5 flex-shrink-0" strokeWidth={2.5} />
                            <span>{t(`agents.${agent.id}.capabilities.${c}`)}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="flex flex-wrap gap-2 text-caption-1 font-mono">
                        <a
                          href={`https://github.com/ZkVanguard/ZKward/blob/main/${agent.implementation}`}
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
            <span className="text-callout font-semibold text-label-primary flex-1">{t('architecture')}</span>
            <ChevronDown className="w-4 h-4 text-label-tertiary group-open:rotate-180 transition-transform" />
          </summary>
          <div className="px-3 pb-3 pt-1 border-t border-separator-opaque/20 space-y-3">
            <p className="text-footnote text-label-secondary leading-relaxed">
              {t.rich('architectureBody', {
                bus: (chunks) => <span className="font-mono text-label-primary">{chunks}</span>,
                base: (chunks) => <span className="font-mono text-label-primary">{chunks}</span>,
              })}
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
