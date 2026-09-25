/**
 * Pure state reducers for the community-pool hook, extracted from
 * useCommunityPool so the state machine has a single home and a test net
 * (test/unit/community-pool-reducers.test.ts). No React, no I/O — pure
 * (state, action) → state, safe to unit-test.
 */
import type {
  CommunityPoolState,
  TransactionState,
  PoolSummary,
  UserPosition,
  AIRecommendation,
  LeaderboardEntry,
  ChainKey,
  TxStatus,
} from './types';

export type PoolAction =
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_POOL_DATA'; payload: PoolSummary | null }
  | { type: 'PATCH_POOL_DATA'; payload: Partial<PoolSummary> }
  | { type: 'SET_USER_POSITION'; payload: UserPosition | null }
  | { type: 'SET_AI_RECOMMENDATION'; payload: AIRecommendation | null }
  | { type: 'SET_LEADERBOARD'; payload: LeaderboardEntry[] }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'SET_SUCCESS'; payload: string | null }
  | { type: 'SET_CHAIN'; payload: ChainKey }
  | { type: 'SET_SUI_POOL_STATE_ID'; payload: string | null }
  | { type: 'RESET_FOR_CHAIN_CHANGE' };

export type TxAction =
  | { type: 'SET_TX_STATUS'; payload: TxStatus }
  | { type: 'SET_ACTION_LOADING'; payload: boolean }
  | { type: 'SET_SHOW_DEPOSIT'; payload: boolean }
  | { type: 'SET_SHOW_WITHDRAW'; payload: boolean }
  | { type: 'SET_DEPOSIT_AMOUNT'; payload: string }
  | { type: 'SET_WITHDRAW_SHARES'; payload: string }
  | { type: 'SET_SUI_DEPOSIT_AMOUNT'; payload: string }
  | { type: 'SET_SUI_WITHDRAW_SHARES'; payload: string }
  | { type: 'SET_LAST_TX_HASH'; payload: string | null }
  | { type: 'RESET_TX_STATE' };

export const initialPoolState: CommunityPoolState = {
  poolData: null,
  userPosition: null,
  aiRecommendation: null,
  leaderboard: [],
  loading: true,
  error: null,
  successMessage: null,
  // SUI pool is the flagship on mainnet; Hedera is the primary EVM chain
  // for Privy users. The chain picker still lets users flip to SUI.
  selectedChain: 'hedera',
  suiPoolStateId: null,
};

export const initialTxState: TransactionState = {
  txStatus: 'idle',
  actionLoading: false,
  showDeposit: false,
  showWithdraw: false,
  depositAmount: '',
  withdrawShares: '',
  suiDepositAmount: '',
  suiWithdrawShares: '',
  lastTxHash: null,
};

export function poolReducer(state: CommunityPoolState, action: PoolAction): CommunityPoolState {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'SET_POOL_DATA':
      return { ...state, poolData: action.payload };
    case 'PATCH_POOL_DATA':
      // Merge partial fields into the existing poolData without wiping
      // it. Used to overlay the DB-verified ATH on top of the on-chain
      // phantom without racing the initial pool fetch.
      return state.poolData
        ? { ...state, poolData: { ...state.poolData, ...action.payload } }
        : state;
    case 'SET_USER_POSITION':
      return { ...state, userPosition: action.payload };
    case 'SET_AI_RECOMMENDATION':
      return { ...state, aiRecommendation: action.payload };
    case 'SET_LEADERBOARD':
      return { ...state, leaderboard: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    case 'SET_SUCCESS':
      return { ...state, successMessage: action.payload };
    case 'SET_CHAIN':
      return { ...state, selectedChain: action.payload };
    case 'SET_SUI_POOL_STATE_ID':
      return { ...state, suiPoolStateId: action.payload };
    case 'RESET_FOR_CHAIN_CHANGE':
      return {
        ...initialPoolState,
        selectedChain: state.selectedChain,
        loading: true,
      };
    default:
      return state;
  }
}

export function txReducer(state: TransactionState, action: TxAction): TransactionState {
  switch (action.type) {
    case 'SET_TX_STATUS':
      return { ...state, txStatus: action.payload };
    case 'SET_ACTION_LOADING':
      return { ...state, actionLoading: action.payload };
    case 'SET_SHOW_DEPOSIT':
      return { ...state, showDeposit: action.payload, showWithdraw: action.payload ? false : state.showWithdraw };
    case 'SET_SHOW_WITHDRAW':
      return { ...state, showWithdraw: action.payload, showDeposit: action.payload ? false : state.showDeposit };
    case 'SET_DEPOSIT_AMOUNT':
      return { ...state, depositAmount: action.payload };
    case 'SET_WITHDRAW_SHARES':
      return { ...state, withdrawShares: action.payload };
    case 'SET_SUI_DEPOSIT_AMOUNT':
      return { ...state, suiDepositAmount: action.payload };
    case 'SET_SUI_WITHDRAW_SHARES':
      return { ...state, suiWithdrawShares: action.payload };
    case 'SET_LAST_TX_HASH':
      return { ...state, lastTxHash: action.payload };
    case 'RESET_TX_STATE':
      return initialTxState;
    default:
      return state;
  }
}
