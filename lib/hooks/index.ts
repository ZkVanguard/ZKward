/**
 * Custom Hooks Library
 * 
 * Reduces code duplication by 50+ lines across dashboard components
 * Standardizes common patterns: polling, loading states, toggles, debouncing
 */

export { usePolling } from './usePolling';
export { useToggle } from './useToggle';
export { useLoading } from './useLoading';
export { useDebounce } from './useDebounce';
export { useWallet, type WalletState } from './useWallet';
export { useReducedMotion, getMotionVariants } from './useReducedMotion';
export { useConnectionSpeed, getAdaptiveTimeout, getAdaptivePollingInterval, type ConnectionSpeed } from './useConnectionSpeed';
export { useIntersectionObserver, useInViewport } from './useIntersectionObserver';
