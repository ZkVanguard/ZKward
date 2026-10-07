/**
 * Community Pool Utilities
 * Pure helper functions - defined outside components to avoid recreation on each render
 */

// ============================================================================
// FORMATTING UTILITIES
// ============================================================================

/**
 * Format USD value with K/M suffixes for large numbers
 */
export function formatUSD(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

/**
 * Format percentage value
 */
export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * Format shares with locale-aware separators
 */
export function formatShares(value: number, decimals = 4): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

/**
 * Truncate wallet address for display
 */
export function truncateAddress(address: string, startChars = 6, endChars = 4): string {
  if (!address) return '';
  if (address.length <= startChars + endChars) return address;
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

// ============================================================================
// CHAIN UTILITIES
// ============================================================================

/**
 * Get chain key from chainId
 */
export function getChainKeyFromId(chainId: number): string | null {
  return chainId === 296 || chainId === 295 ? 'hedera' : null;
}

/**
 * Get valid chain IDs for a chain key
 */
export function getValidChainIds(chainKey: string): number[] {
  return chainKey === 'hedera' ? [296, 295] : [];
}

/**
 * Get network from chainId
 */
export function getNetworkFromChainId(chainId: number): 'testnet' | 'mainnet' {
  return chainId === 295 ? 'mainnet' : 'testnet';
}

// ============================================================================
// ASSET DISPLAY CONSTANTS
// ============================================================================

export const ASSET_COLORS: Record<string, string> = {
  BTC: 'bg-orange-500',
  ETH: 'bg-blue-500',
  SUI: 'bg-cyan-400',
  CRO: 'bg-indigo-500',
  ARB: 'bg-sky-500',
  USDC: 'bg-emerald-500',
  USDT: 'bg-teal-500',
};

export const ASSET_ICONS: Record<string, string> = {
  BTC: '₿',
  ETH: 'Ξ',
  SUI: '💧',
  CRO: '🔷',
  ARB: '🔵',
  USDC: '$',
};

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

/**
 * Validate deposit amount
 */
export function validateDepositAmount(amount: string, minUSD = 10): { valid: boolean; error?: string } {
  if (!amount) {
    return { valid: false, error: 'Please enter a deposit amount' };
  }
  
  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) {
    return { valid: false, error: 'Invalid deposit amount' };
  }
  
  if (parsed < minUSD) {
    return { valid: false, error: `Minimum deposit is $${minUSD}` };
  }
  
  return { valid: true };
}

/**
 * Validate withdrawal shares
 */
export function validateWithdrawShares(shares: string, maxShares: number): { valid: boolean; error?: string } {
  if (!shares) {
    return { valid: false, error: 'Please enter the number of shares to withdraw' };
  }
  
  const parsed = parseFloat(shares);
  if (isNaN(parsed) || parsed <= 0) {
    return { valid: false, error: 'Invalid share amount' };
  }
  
  if (parsed > maxShares) {
    return { valid: false, error: `Maximum shares: ${maxShares.toFixed(4)}` };
  }
  
  return { valid: true };
}

/**
 * Validate SUI deposit amount
 */
export function validateSuiDeposit(amount: string, minSUI = 0.1): { valid: boolean; error?: string } {
  if (!amount) {
    return { valid: false, error: 'Please enter a deposit amount in SUI' };
  }
  
  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) {
    return { valid: false, error: 'Invalid deposit amount' };
  }
  
  if (parsed < minSUI) {
    return { valid: false, error: `Minimum deposit is ${minSUI} SUI` };
  }
  
  return { valid: true };
}

// ============================================================================
// ALLOCATION UTILITIES
// ============================================================================

/**
 * Get allocation percentage from various formats
 */
export function getAllocationPercent(alloc: number | { percentage?: number }): number {
  return typeof alloc === 'number' ? alloc : (alloc?.percentage ?? 0);
}

/**
 * Filter allocations with positive values
 */
export function getActiveAllocations(allocations: Record<string, number | { percentage?: number }>): Array<[string, number]> {
  return Object.entries(allocations)
    .map(([asset, alloc]) => [asset, getAllocationPercent(alloc)] as [string, number])
    .filter(([_, percent]) => percent > 0);
}
