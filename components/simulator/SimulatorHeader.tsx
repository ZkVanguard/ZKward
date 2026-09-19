/**
 * Simulator page header + live API status pills.
 *
 * Extracted from app/[locale]/simulator/page.tsx (2026-09-18) to keep the
 * top-of-page markup out of the 2283-LOC god file. Zero state — reads
 * apiStatus + realPrices via props.
 */
import { Activity, Wifi, WifiOff } from 'lucide-react';
interface ApiStatus {
  ollama: boolean;
  prices: boolean;
  zkBackend: boolean;
  agents: boolean;
}

interface Props {
  apiStatus: ApiStatus;
  realPrices: Record<string, number>;
}

function StatusPill({ label, ok, icon }: { label: string; ok: boolean; icon?: string }) {
  return (
    <div
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium ${
        ok ? 'bg-[#34C759]/10 text-[#34C759]' : 'bg-[#FF9500]/10 text-[#FF9500]'
      }`}
    >
      {ok ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
      {icon && <span>{icon} </span>}
      {label} {ok ? '✓' : '○'}
    </div>
  );
}

export function SimulatorHeader({ apiStatus, realPrices }: Props) {
  return (
    <div className="mb-6 sm:mb-8">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-12 h-12 sm:w-14 sm:h-14 bg-gradient-to-br from-[#AF52DE] to-[#5856D6] rounded-[16px] flex items-center justify-center shadow-lg">
          <Activity className="w-6 h-6 sm:w-7 sm:h-7 text-white" />
        </div>
        <div>
          <h1 className="text-[28px] sm:text-[34px] lg:text-[40px] font-bold text-[#1d1d1f] tracking-[-0.02em]">
            Portfolio Stress Simulator
          </h1>
          <p className="text-[14px] sm:text-[15px] text-[#86868b]">
            Replay historical market events with REAL platform integrations
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mt-3">
        <StatusPill label="Ollama/Qwen" ok={apiStatus.ollama} icon="🤖" />
        <StatusPill label="Crypto.com API" ok={apiStatus.prices} />
        <StatusPill label="ZK Backend" ok={apiStatus.zkBackend} />
        <StatusPill label="Agent Swarm" ok={apiStatus.agents} />
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium bg-[#AF52DE]/10 text-[#AF52DE]">
          📜 Historical Data Loaded
        </div>
        {Object.keys(realPrices).length > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium bg-[#007AFF]/10 text-[#007AFF]">
            Live BTC ${realPrices.BTC?.toLocaleString() || '—'}
          </div>
        )}
      </div>
    </div>
  );
}
