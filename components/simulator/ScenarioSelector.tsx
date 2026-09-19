/**
 * Scenario picker + play/pause/reset controls + progress bar.
 *
 * Extracted from simulator/page.tsx 2026-09-18. All state lives in the
 * parent; this component is presentational.
 */
import { Play, Pause, RotateCcw } from 'lucide-react';
import { motion } from 'framer-motion';
import { scenarios } from '@/app/[locale]/simulator/constants';
import type { SimulationScenario } from '@/app/[locale]/simulator/types';

interface Props {
  selectedScenario: SimulationScenario;
  setSelectedScenario: (s: SimulationScenario) => void;
  isRunning: boolean;
  isPaused: boolean;
  elapsedTime: number;
  progress: number;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
}

export function ScenarioSelector({
  selectedScenario,
  setSelectedScenario,
  isRunning,
  isPaused,
  elapsedTime,
  progress,
  onRun,
  onPause,
  onResume,
  onReset,
}: Props) {
  return (
    <div className="bg-white rounded-[16px] sm:rounded-[20px] border border-black/5 p-4 sm:p-5 mb-5 sm:mb-6 shadow-sm">
      <div className="flex flex-col sm:flex-row flex-wrap items-stretch gap-4">
        <div className="flex-1 min-w-[150px]">
          <label className="text-[12px] sm:text-[13px] font-medium text-[#86868b] mb-2 block">
            Select Scenario
          </label>
          <select
            value={selectedScenario.id}
            onChange={(e) =>
              setSelectedScenario(scenarios.find((s) => s.id === e.target.value)!)
            }
            disabled={isRunning}
            className="w-full bg-[#f5f5f7] border border-black/5 rounded-[10px] px-3 py-2.5 text-[#1d1d1f] focus:border-[#007AFF] focus:ring-2 focus:ring-[#007AFF]/20 focus:outline-none text-[14px] sm:text-[15px] transition-all"
          >
            {scenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] sm:text-[12px] text-[#86868b] mt-1.5">
            {selectedScenario.description}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-2 w-full sm:w-auto">
          {!isRunning ? (
            <button
              onClick={onRun}
              className="flex items-center justify-center gap-2 px-6 py-3 bg-[#34C759] text-white rounded-[12px] font-semibold text-[15px] hover:bg-[#2DB84D] active:scale-[0.98] transition-all shadow-sm w-full sm:w-auto"
            >
              <Play className="w-5 h-5" />
              Execute Strategy
            </button>
          ) : isPaused ? (
            <button
              onClick={onResume}
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[#34C759] text-white rounded-[10px] font-semibold text-[14px] hover:bg-[#2DB84D] active:scale-[0.98] transition-all w-full sm:w-auto"
            >
              <Play className="w-4 h-4" />
              Resume
            </button>
          ) : (
            <button
              onClick={onPause}
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[#FF9500] text-white rounded-[10px] font-semibold text-[14px] hover:bg-[#E68A00] active:scale-[0.98] transition-all w-full sm:w-auto"
            >
              <Pause className="w-4 h-4" />
              Pause
            </button>
          )}
          <button
            onClick={onReset}
            className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[#f5f5f7] text-[#1d1d1f] rounded-[10px] font-medium text-[14px] hover:bg-[#e8e8ed] active:scale-[0.98] transition-all w-full sm:w-auto"
          >
            <RotateCcw className="w-4 h-4" />
            Reset
          </button>
        </div>
      </div>

      {isRunning && (
        <div className="mt-4">
          <div className="flex justify-between text-[12px] sm:text-[13px] text-[#86868b] mb-1.5">
            <span>Progress: {progress.toFixed(0)}%</span>
            <span>
              Elapsed: {elapsedTime}s / {selectedScenario.duration}s
            </span>
          </div>
          <div className="h-2 bg-[#e8e8ed] rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-[#007AFF] to-[#5856D6]"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
