/**
 * Risk policy summary card — pure display of the RISK_POLICY constant.
 *
 * Extracted from simulator/page.tsx 2026-09-18. Zero state dependency.
 */
import { Shield } from 'lucide-react';
import { RISK_POLICY } from '@/app/[locale]/simulator/constants';

export function RiskPolicyPanel() {
  return (
    <div className="bg-white rounded-[16px] sm:rounded-[20px] border border-black/5 p-4 sm:p-5 mb-5 sm:mb-6 shadow-sm">
      <h2 className="text-[15px] sm:text-[17px] font-semibold text-[#1d1d1f] mb-3 flex items-center gap-2">
        <div className="w-8 h-8 bg-[#AF52DE]/10 rounded-[8px] flex items-center justify-center">
          <Shield className="w-4 h-4 text-[#AF52DE]" />
        </div>
        Risk Policy (Institutional)
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-[#f5f5f7] rounded-[10px] p-3">
          <div className="text-[11px] sm:text-[12px] text-[#86868b] mb-0.5">Max Drawdown</div>
          <div className="text-[15px] sm:text-[17px] font-semibold text-[#1d1d1f]">
            {(RISK_POLICY.maxDrawdown * 100).toFixed(1)}%
          </div>
        </div>
        <div className="bg-[#f5f5f7] rounded-[10px] p-3">
          <div className="text-[11px] sm:text-[12px] text-[#86868b] mb-0.5">Hedge Ratio</div>
          <div className="text-[15px] sm:text-[17px] font-semibold text-[#1d1d1f]">
            {(RISK_POLICY.hedgeRatio * 100).toFixed(0)}%
          </div>
        </div>
        <div className="bg-[#f5f5f7] rounded-[10px] p-3">
          <div className="text-[11px] sm:text-[12px] text-[#86868b] mb-0.5">VaR Threshold</div>
          <div className="text-[15px] sm:text-[17px] font-semibold text-[#1d1d1f]">
            {(RISK_POLICY.varThreshold * 100).toFixed(1)}%
          </div>
        </div>
        <div className="bg-[#f5f5f7] rounded-[10px] p-3 col-span-2 sm:col-span-1">
          <div className="text-[11px] sm:text-[12px] text-[#86868b] mb-0.5">
            Allowed Instruments
          </div>
          <div className="text-[13px] sm:text-[14px] font-semibold text-[#1d1d1f]">
            {RISK_POLICY.allowedInstruments.join(', ')}
          </div>
        </div>
      </div>
    </div>
  );
}
