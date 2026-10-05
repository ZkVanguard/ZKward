/**
 * Every rule that can refuse or shrink a PaperTrader entry, by name.
 *
 * The book applies these rules inline, in an order of its own. This list
 * exists so the signal ledger can ask each rule separately "would you
 * refuse this coin's signal right now?" and record the answer. The feedback
 * loop then measures what a rule refuses, which is the only way to learn
 * whether the rule helps: a gate that kept the book on one side of the
 * market for three days (2026-10-02 to 10-05) was invisible until someone
 * replayed it by hand.
 *
 * Each check calls the function the book calls and, like the book, treats
 * a failed lookup as "does not refuse". A rule the book applies that is
 * missing here goes unmeasured; test/unit/entry-gates.test.ts fails on it.
 *
 * Not listed, on purpose: the one-position-per-coin and cluster limits
 * (they describe the book's open positions, not the signal) and the ledger
 * admission rule (it is the loop's own verdict).
 */
import { getCronState } from '@/lib/db/cron-state';
import { calibrate } from '@/lib/services/ai/probability-calibrator';
import type { AggregatedPrediction } from '@/lib/services/market-data/PredictionAggregatorService';
import { assetSideBlacklistRejection } from './asset-side-blacklist';
import {
  KEY_NAV,
  PAPER_CALIBRATED_MIN_WIN_RATE,
  PAPER_CALIBRATED_RANK_MIN_N,
  PAPER_MIN_CONFIDENCE,
  PAPER_MIN_CONSENSUS,
  PAPER_MIN_MAJORITY_PCT,
  PAPER_MIN_SOURCES,
  PAPER_SKIP_STRONG_SIGNALS,
  PAPER_STARTING_NAV,
} from './config';
import { entryConfidenceFloor, type Regime } from './regime';
import { isSignalStable, majorityAgreementPct } from './signal-quality';
import type { Side } from './simulated-executor';
import { assetSideStreakRejection, assetStreakRejection, regretCooldownRejection } from './streak-guard';
import { lowVolatilityRejection } from './volatility-gate';

/** What the gates share on one tick: read once, not once per coin. */
export interface GateSetting {
  now: number;
  nav: number;
  minConfidence: number;
  regime: Regime | null;
}

export interface GateSignal {
  asset: string;
  direction: 'UP' | 'DOWN';
  prediction: Pick<AggregatedPrediction, 'confidence' | 'consensus' | 'sources' | 'recommendation'>;
}

export interface EntryGate {
  name: string;
  refuses(signal: GateSignal, setting: GateSetting): boolean | Promise<boolean>;
}

const sideOf = (direction: 'UP' | 'DOWN'): Side => (direction === 'UP' ? 'LONG' : 'SHORT');

export const ENTRY_GATES: readonly EntryGate[] = [
  { name: 'min-confidence', refuses: (s, e) => s.prediction.confidence < e.minConfidence },
  { name: 'min-consensus', refuses: (s) => s.prediction.consensus < PAPER_MIN_CONSENSUS },
  { name: 'min-sources', refuses: (s) => s.prediction.sources.length < PAPER_MIN_SOURCES },
  { name: 'majority', refuses: (s) => majorityAgreementPct(s.direction, s.prediction.sources) < PAPER_MIN_MAJORITY_PCT },
  { name: 'stability', refuses: async (s) => !(await isSignalStable(s.asset, s.direction)).stable },
  {
    name: 'calibrator',
    refuses: async (s) => {
      const cal = await calibrate({ asset: s.asset, side: sideOf(s.direction), rawConfidencePct: s.prediction.confidence, namespace: 'paper' });
      return cal.nHistory >= PAPER_CALIBRATED_RANK_MIN_N && cal.pCalibrated < PAPER_CALIBRATED_MIN_WIN_RATE;
    },
  },
  { name: 'side-streak', refuses: async (s, e) => (await assetSideStreakRejection(s.asset, sideOf(s.direction), e.now)) !== null },
  { name: 'asset-streak', refuses: async (s, e) => (await assetStreakRejection(s.asset, e.now)) !== null },
  { name: 'low-volatility', refuses: async (s) => (await lowVolatilityRejection(s.asset)) !== null },
  { name: 'regret', refuses: async (s, e) => (await regretCooldownRejection(s.asset, sideOf(s.direction), e.nav)) !== null },
  // The next three size a trade down to a probe rather than keep it out.
  { name: 'strong-signal', refuses: (s) => PAPER_SKIP_STRONG_SIGNALS && s.prediction.recommendation.startsWith('STRONG_') },
  { name: 'blacklist', refuses: async (s) => (await assetSideBlacklistRejection(s.asset, sideOf(s.direction))) !== null },
  { name: 'chop', refuses: (_s, e) => e.regime === 'CHOP' },
];

export async function entryGateSetting(now: number): Promise<GateSetting> {
  const [nav, floor] = await Promise.all([getCronState<number>(KEY_NAV), entryConfidenceFloor(PAPER_MIN_CONFIDENCE, now)]);
  return { now, nav: nav ?? PAPER_STARTING_NAV, ...floor };
}

/** Names of the gates that would refuse this signal. A gate whose check fails does not refuse. */
export async function gateRefusals(signal: GateSignal, setting: GateSetting, gates: readonly EntryGate[] = ENTRY_GATES): Promise<string[]> {
  const answers = await Promise.all(
    gates.map(async (gate) => {
      try {
        return (await gate.refuses(signal, setting)) ? gate.name : null;
      } catch {
        return null;
      }
    }),
  );
  return answers.filter((name): name is string => name !== null);
}
