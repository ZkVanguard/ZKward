/**
 * Real Event Data card — shown only for the tariff scenario.
 * Renders historical prediction market data + market impact + prices from
 * the HISTORICAL_SNAPSHOTS constant.
 *
 * Extracted from simulator/page.tsx 2026-09-18. Zero state — reads only
 * from constants + selectedScenario.eventData via prop.
 */
import { AlertTriangle } from 'lucide-react';
import { HISTORICAL_SNAPSHOTS } from '@/app/[locale]/simulator/constants';
import type { SimulationScenario } from '@/app/[locale]/simulator/types';

interface Props {
  selectedScenario: SimulationScenario;
}

export function RealEventDataCard({ selectedScenario }: Props) {
  if (selectedScenario.type !== 'tariff' || !selectedScenario.eventData) return null;
  const snapshot = HISTORICAL_SNAPSHOTS['trump-tariff-crash'];
  const { eventData } = selectedScenario;

  return (
    <div className="bg-white rounded-[16px] sm:rounded-[20px] border-2 border-[#FF3B30]/30 p-4 sm:p-5 mb-5 sm:mb-6 shadow-sm">
      <div className="flex items-start gap-3 sm:gap-4">
        <div className="w-12 h-12 sm:w-14 sm:h-14 bg-[#FF3B30]/10 rounded-[14px] flex items-center justify-center flex-shrink-0">
          <AlertTriangle className="w-6 h-6 sm:w-7 sm:h-7 text-[#FF3B30]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-[11px] sm:text-[12px] px-2.5 py-1 bg-[#AF52DE]/10 text-[#AF52DE] rounded-full font-semibold border border-[#AF52DE]/30">
              📜 HISTORICAL DATA
            </span>
            <span className="text-[11px] sm:text-[12px] px-2.5 py-1 bg-[#FF3B30]/10 text-[#FF3B30] rounded-full font-semibold border border-[#FF3B30]/30">
              REAL EVENT
            </span>
            <span className="text-[11px] sm:text-[12px] text-[#86868b]">
              {snapshot.timestamp}
            </span>
          </div>
          <h3 className="text-[17px] sm:text-[20px] font-bold text-[#FF3B30] mb-2">
            {eventData.headline}
          </h3>
          <p className="text-[13px] sm:text-[14px] text-[#86868b] mb-4 leading-relaxed">
            {eventData.marketContext}
          </p>

          {/* Historical Prediction Market Data */}
          <div className="bg-[#AF52DE]/5 border border-[#AF52DE]/20 rounded-[12px] p-3 sm:p-4 mb-4">
            <div className="text-[#AF52DE] font-semibold text-[13px] sm:text-[14px] mb-3 flex items-center gap-2">
              <span>📜</span> Historical Prediction Market Data (Oct 10, 2025)
            </div>

            {/* Polymarket */}
            <div className="mb-3">
              <div className="text-[11px] text-[#86868b] mb-2 font-semibold">POLYMARKET</div>
              <div className="grid grid-cols-1 gap-2">
                {snapshot.polymarket.map((p, i) => (
                  <div key={i} className="bg-white rounded-[8px] p-2 border border-black/5">
                    <div className="text-[11px] text-[#1d1d1f] mb-1">"{p.question}"</div>
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] font-mono font-medium text-[#1d1d1f]">
                        {p.probBefore}% →{' '}
                        <span className="text-[#FF3B30]">{p.probAfter}%</span>
                      </span>
                      <span className="text-[10px] text-[#86868b]">
                        ${(p.volume / 1e6).toFixed(1)}M • {p.timeToSpike}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Kalshi + PredictIt */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[11px] text-[#86868b] mb-2 font-semibold">KALSHI</div>
                {snapshot.kalshi.map((k, i) => (
                  <div key={i} className="bg-white rounded-[8px] p-2 border border-black/5 mb-1">
                    <div className="text-[10px] text-[#1d1d1f] mb-1">{k.question}</div>
                    <div className="text-[12px] font-mono">
                      {k.probBefore}% → <span className="text-[#FF3B30]">{k.probAfter}%</span>
                    </div>
                  </div>
                ))}
              </div>
              <div>
                <div className="text-[11px] text-[#86868b] mb-2 font-semibold">PREDICTIT</div>
                {snapshot.predictit.map((p, i) => (
                  <div key={i} className="bg-white rounded-[8px] p-2 border border-black/5 mb-1">
                    <div className="text-[10px] text-[#1d1d1f] mb-1">{p.question}</div>
                    <div className="text-[12px] font-mono">
                      {p.probBefore}% → <span className="text-[#FF3B30]">{p.probAfter}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-3 p-2 bg-[#34C759]/10 rounded-[8px] text-center">
              <span className="text-[#34C759] font-semibold text-[13px]">
                Delphi Consensus: {snapshot.delphiConsensus.before} →{' '}
                {snapshot.delphiConsensus.after} ({snapshot.delphiConsensus.confidence})
              </span>
            </div>
          </div>

          {/* Market Impact */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-[#FF3B30]/5 rounded-[10px] p-3 border border-[#FF3B30]/20">
              <div className="text-[11px] sm:text-[12px] text-[#86868b] mb-1">Total Liquidations</div>
              <div className="text-[17px] sm:text-[20px] text-[#FF3B30] font-bold">
                ${(snapshot.marketData.totalLiquidations / 1e9).toFixed(1)}B
              </div>
            </div>
            <div className="bg-[#FF3B30]/5 rounded-[10px] p-3 border border-[#FF3B30]/20">
              <div className="text-[11px] sm:text-[12px] text-[#86868b] mb-1">Affected Traders</div>
              <div className="text-[17px] sm:text-[20px] text-[#FF3B30] font-bold">
                {snapshot.marketData.affectedAccounts.toLocaleString()}
              </div>
            </div>
            <div className="bg-[#FF9500]/5 rounded-[10px] p-3 border border-[#FF9500]/20">
              <div className="text-[11px] sm:text-[12px] text-[#86868b] mb-1">Volatility Spike</div>
              <div className="text-[17px] sm:text-[20px] text-[#FF9500] font-bold">
                {snapshot.marketData.btcVolatility.before} → {snapshot.marketData.btcVolatility.peak}
              </div>
            </div>
          </div>

          {/* Historical Prices */}
          <div className="mt-3 bg-[#f5f5f7] rounded-[10px] p-3">
            <div className="text-[11px] sm:text-[12px] text-[#86868b] mb-2">
              Historical Price Movement
            </div>
            <div className="flex flex-wrap gap-4">
              {Object.entries(snapshot.prices).map(([symbol, data]) => (
                <div key={symbol} className="text-[13px] sm:text-[14px] text-[#1d1d1f] font-mono">
                  <span className="font-semibold">{symbol}:</span> ${data.before.toLocaleString()} →{' '}
                  ${data.after.toLocaleString()}
                  <span className="text-[#FF3B30] ml-1">({data.change}%)</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 text-[10px] sm:text-[11px] text-[#86868b]">
            Historical Data Sources: Polymarket Archive • Kalshi Historical • PredictIt Records • Crypto.com Exchange Data
          </div>
        </div>
      </div>
    </div>
  );
}
