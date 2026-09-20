/**
 * SUI Contract Hooks
 * 
 * React hooks for interacting with ZKward Move modules on SUI
 */

import { useCallback, useState } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { useSuiSafe } from '../../app/sui-providers';

// ============================================
// TYPES
// ============================================

export interface PortfolioCreateParams {
  targetYield: number;  // Basis points (e.g., 800 = 8%)
  riskTolerance: number; // 0-100
  depositAmount: bigint;  // In MIST (1 SUI = 10^9 MIST)
}

export interface DepositParams {
  portfolioId: string;
  amount: bigint;
}

export interface WithdrawParams {
  portfolioId: string;
  amount: bigint;
}

export interface VerifyProofParams {
  proofData: Uint8Array;
  commitmentHash: Uint8Array;
  proofType: string;
  metadata?: string;
}

export interface RoutePaymentParams {
  amount: bigint;
  recipient: string;
  reference?: string;
}

export interface TransactionResult {
  success: boolean;
  digest?: string;
  error?: string;
}

// ============================================
// RWA MANAGER HOOKS
// ============================================

/**
 * Hook for RWA Manager contract interactions
 * Safe to call even when SUI wallet isn't connected
 */
export function useRWAManager() {
  const suiContext = useSuiSafe();
  
  const address = suiContext?.address ?? null;
  const isConnected = suiContext?.isConnected ?? false;
  const executeTransaction = suiContext?.executeTransaction;
  const contractAddresses = suiContext?.contractAddresses;
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Create a new portfolio
   */
  const createPortfolio = useCallback(async (
    params: PortfolioCreateParams
  ): Promise<TransactionResult> => {
    if (!isConnected || !address || !executeTransaction) {
      return { success: false, error: 'SUI wallet not connected' };
    }

    if (!contractAddresses?.packageId || !contractAddresses?.rwaManagerState) {
      return { success: false, error: 'Contract addresses not configured' };
    }

    setLoading(true);
    setError(null);

    try {
      const tx = new Transaction();
      
      // Split coins for deposit
      const [depositCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(params.depositAmount)]);

      tx.moveCall({
        target: `${contractAddresses.packageId}::rwa_manager::create_portfolio`,
        arguments: [
          tx.object(contractAddresses.rwaManagerState),
          tx.pure.u64(params.targetYield),
          tx.pure.u64(params.riskTolerance),
          depositCoin,
          tx.object('0x6'), // Clock object
        ],
      });

      const result = await executeTransaction(tx);
      
      setLoading(false);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setLoading(false);
      return { success: false, error: message };
    }
  }, [isConnected, address, executeTransaction, contractAddresses]);

  /**
   * Deposit to existing portfolio
   */
  const deposit = useCallback(async (
    params: DepositParams
  ): Promise<TransactionResult> => {
    if (!isConnected || !address || !executeTransaction) {
      return { success: false, error: 'SUI wallet not connected' };
    }

    if (!contractAddresses?.packageId || !contractAddresses?.rwaManagerState) {
      return { success: false, error: 'Contract addresses not configured' };
    }

    setLoading(true);
    setError(null);

    try {
      const tx = new Transaction();
      
      const [depositCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(params.amount)]);

      tx.moveCall({
        target: `${contractAddresses.packageId}::rwa_manager::deposit`,
        arguments: [
          tx.object(contractAddresses.rwaManagerState),
          tx.object(params.portfolioId),
          depositCoin,
        ],
      });

      const result = await executeTransaction(tx);
      
      setLoading(false);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setLoading(false);
      return { success: false, error: message };
    }
  }, [isConnected, address, executeTransaction, contractAddresses]);

  /**
   * Withdraw from portfolio
   */
  const withdraw = useCallback(async (
    params: WithdrawParams
  ): Promise<TransactionResult> => {
    if (!isConnected || !address || !executeTransaction) {
      return { success: false, error: 'SUI wallet not connected' };
    }

    if (!contractAddresses?.packageId || !contractAddresses?.rwaManagerState) {
      return { success: false, error: 'Contract addresses not configured' };
    }

    setLoading(true);
    setError(null);

    try {
      const tx = new Transaction();

      tx.moveCall({
        target: `${contractAddresses.packageId}::rwa_manager::withdraw`,
        arguments: [
          tx.object(contractAddresses.rwaManagerState),
          tx.object(params.portfolioId),
          tx.pure.u64(params.amount),
        ],
      });

      const result = await executeTransaction(tx);
      
      setLoading(false);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setLoading(false);
      return { success: false, error: message };
    }
  }, [isConnected, address, executeTransaction, contractAddresses]);

  return {
    createPortfolio,
    deposit,
    withdraw,
    loading,
    error,
  };
}

// ============================================
// ZK VERIFIER HOOKS
// ============================================

/**
 * Hook for ZK Verifier contract interactions
 * Safe to call even when SUI wallet isn't connected
 */
export function useZKVerifier() {
  const suiContext = useSuiSafe();
  
  const address = suiContext?.address ?? null;
  const isConnected = suiContext?.isConnected ?? false;
  const executeTransaction = suiContext?.executeTransaction;
  const contractAddresses = suiContext?.contractAddresses;
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Verify a ZK proof
   */
  const verifyProof = useCallback(async (
    params: VerifyProofParams
  ): Promise<TransactionResult> => {
    if (!isConnected || !address || !executeTransaction) {
      return { success: false, error: 'SUI wallet not connected' };
    }

    if (!contractAddresses?.packageId || !contractAddresses?.zkVerifierState) {
      return { success: false, error: 'Contract addresses not configured' };
    }

    setLoading(true);
    setError(null);

    try {
      const tx = new Transaction();

      tx.moveCall({
        target: `${contractAddresses.packageId}::zk_verifier::verify_proof`,
        arguments: [
          tx.object(contractAddresses.zkVerifierState),
          tx.pure.vector('u8', Array.from(params.proofData)),
          tx.pure.vector('u8', Array.from(params.commitmentHash)),
          tx.pure.string(params.proofType),
          tx.pure.string(params.metadata || ''),
          tx.object('0x6'), // Clock object
        ],
      });

      const result = await executeTransaction(tx);
      
      setLoading(false);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setLoading(false);
      return { success: false, error: message };
    }
  }, [isConnected, address, executeTransaction, contractAddresses]);

  /**
   * Create a ZK commitment
   */
  const createCommitment = useCallback(async (
    commitmentData: Uint8Array,
    strategyType: string,
    riskLevel: number
  ): Promise<TransactionResult> => {
    if (!isConnected || !address || !executeTransaction) {
      return { success: false, error: 'SUI wallet not connected' };
    }

    if (!contractAddresses?.packageId || !contractAddresses?.zkVerifierState) {
      return { success: false, error: 'Contract addresses not configured' };
    }

    setLoading(true);
    setError(null);

    try {
      const tx = new Transaction();

      tx.moveCall({
        target: `${contractAddresses.packageId}::zk_verifier::create_commitment`,
        arguments: [
          tx.object(contractAddresses.zkVerifierState),
          tx.pure.vector('u8', Array.from(commitmentData)),
          tx.pure.string(strategyType),
          tx.pure.u64(riskLevel),
          tx.object('0x6'), // Clock object
        ],
      });

      const result = await executeTransaction(tx);
      
      setLoading(false);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setLoading(false);
      return { success: false, error: message };
    }
  }, [isConnected, address, executeTransaction, contractAddresses]);

  return {
    verifyProof,
    createCommitment,
    loading,
    error,
  };
}

// ============================================
// PAYMENT ROUTER HOOKS
// ============================================

/**
 * Hook for Payment Router contract interactions
 * Safe to call even when SUI wallet isn't connected
 */
export function usePaymentRouter() {
  const suiContext = useSuiSafe();
  
  const address = suiContext?.address ?? null;
  const isConnected = suiContext?.isConnected ?? false;
  const executeTransaction = suiContext?.executeTransaction;
  const contractAddresses = suiContext?.contractAddresses;
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Route a payment
   */
  const routePayment = useCallback(async (
    params: RoutePaymentParams
  ): Promise<TransactionResult> => {
    if (!isConnected || !address || !executeTransaction) {
      return { success: false, error: 'SUI wallet not connected' };
    }

    if (!contractAddresses?.packageId || !contractAddresses?.paymentRouterState) {
      return { success: false, error: 'Contract addresses not configured' };
    }

    setLoading(true);
    setError(null);

    try {
      const tx = new Transaction();
      
      const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(params.amount)]);

      tx.moveCall({
        target: `${contractAddresses.packageId}::payment_router::route_payment`,
        arguments: [
          tx.object(contractAddresses.paymentRouterState),
          paymentCoin,
          tx.pure.address(params.recipient),
          tx.pure.string(params.reference || ''),
          tx.object('0x6'), // Clock object
        ],
      });

      const result = await executeTransaction(tx);
      
      setLoading(false);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setLoading(false);
      return { success: false, error: message };
    }
  }, [isConnected, address, executeTransaction, contractAddresses]);

  /**
   * Deposit to sponsor fund
   */
  const depositSponsorFund = useCallback(async (
    amount: bigint
  ): Promise<TransactionResult> => {
    if (!isConnected || !address || !executeTransaction) {
      return { success: false, error: 'SUI wallet not connected' };
    }

    if (!contractAddresses?.packageId || !contractAddresses?.paymentRouterState) {
      return { success: false, error: 'Contract addresses not configured' };
    }

    setLoading(true);
    setError(null);

    try {
      const tx = new Transaction();
      
      const [depositCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);

      tx.moveCall({
        target: `${contractAddresses.packageId}::payment_router::deposit_sponsor_fund`,
        arguments: [
          tx.object(contractAddresses.paymentRouterState),
          depositCoin,
        ],
      });

      const result = await executeTransaction(tx);
      
      setLoading(false);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setLoading(false);
      return { success: false, error: message };
    }
  }, [isConnected, address, executeTransaction, contractAddresses]);

  return {
    routePayment,
    depositSponsorFund,
    loading,
    error,
  };
}
