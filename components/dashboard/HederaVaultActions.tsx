'use client';

/**
 * HederaVaultActions — deposit / withdraw for the SimpleUsdcVault on
 * Hedera Testnet. Standalone from the SUI/Cronos DepositWithdrawActions
 * because that component's logic is welded to WDK + permit + smart-account
 * flows that Hedera doesn't need.
 *
 * Flow
 *   Deposit:  approve(usdc, pool, amount) → deposit(amount)
 *   Withdraw: withdraw(shares)
 *
 * Wallet: whatever wagmi's useAccount returns. Privy's WagmiProvider
 * transparently proxies the embedded wallet's signer, so this works
 * with both email/Google Privy users AND MetaMask/injected users.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseUnits, formatUnits, erc20Abi, encodeFunctionData } from 'viem';
import {
  useAccount,
  useBalance,
  useChainId,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
} from 'wagmi';
import { Plus, Minus, Loader2, Check, ExternalLink, AlertTriangle, Wallet, Droplets, Copy, Pencil } from 'lucide-react';
import { HEDERA_CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';
import { hederaTestnet } from '@/lib/evm-wallet/wagmi-config';
import { usePrivyEmbeddedAddress, usePrivyEmbeddedStatus } from '@/lib/evm-wallet/usePrivyEmbeddedAddress';
import { usePrivySender } from '@/lib/evm-wallet/usePrivySender';
import { WalletAvatar } from '@/components/ui/WalletAvatar';
import { useWalletProfile, useSetWalletProfile } from '@/lib/hooks/useWalletProfile';

const HEDERA_TESTNET_ID = 296;
const USDC_DECIMALS = 6;
// SimpleUsdcVault stores shares in the same 6-decimal unit as USDC
// (contract math preserves asset decimals). NOT 18 like most ERC-4626s.
const SHARES_DECIMALS = 6;
const HEDERA_ACCENT = '#00A79F';
const ACCENT = '#0069D9';

// Hashio (Hedera EVM relay) rejects transactions without explicit fees
// with 400 → Privy surfaces "Missing or invalid parameters".
// Fees must be sized against the *user's* HBAR balance, not the operator's:
// Hashio reserves maxFeePerGas × gas up front, so a fresh wallet with only
// the faucet's 1 HBAR drip cannot cover big reservations. Hedera's actual
// base fee floats around ~700 gwei; 1500 gives comfortable headroom.
const HASHIO_MAX_FEE_PER_GAS = 1_500_000_000_000n; // 1500 gwei
const HASHIO_PRIORITY_FEE = 100_000_000_000n;      // 100 gwei (Hedera ignores tip)
const HASHIO_GAS_APPROVE = 100_000n;   // ~0.15 HBAR reservation
const HASHIO_GAS_DEPOSIT = 300_000n;   // ~0.45 HBAR reservation
const HASHIO_GAS_WITHDRAW = 300_000n;  // ~0.45 HBAR reservation

// SimpleUsdcVaultV2 ABI subset — deposit / depositWithPermit / withdraw / reads.
const VAULT_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    name: 'depositWithPermit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    name: 'sharesOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'totalShares',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'totalAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

// EIP-2612 permit ABI on the USDC token — nonces + DOMAIN_SEPARATOR reads,
// permit not needed on client (vault calls it internally in depositWithPermit).
const PERMIT_TOKEN_ABI = [
  {
    name: 'nonces',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'name',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
] as const;

interface Props {
  /** Address override (Privy embedded wallet) — overrides wagmi useAccount */
  address?: `0x${string}`;
  onRefresh?: () => void;
}

function truncate(v: string): string {
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

export function HederaVaultActions({ address: propAddress, onRefresh }: Props) {
  const { address: wagmiAddress } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const address = (propAddress ?? wagmiAddress) as `0x${string}` | undefined;

  // Privy path — when the "from" address IS the user's Privy embedded
  // wallet, sign via Privy's useSendTransaction so wagmi's active
  // connector (which is MetaMask when both are connected) doesn't hijack
  // the prompt. Falls back to wagmi writeContract when the address is
  // MetaMask/injected or when Privy isn't enabled.
  const privyEmbeddedAddress = usePrivyEmbeddedAddress();
  const privyStatus = usePrivyEmbeddedStatus();
  const privySender = usePrivySender();
  const isPrivySigner = !!privyEmbeddedAddress
    && !!privySender
    && !!address
    && address.toLowerCase() === privyEmbeddedAddress.toLowerCase();

  const usdc = HEDERA_CONTRACT_ADDRESSES.testnet.usdtToken as `0x${string}`;
  const vault = HEDERA_CONTRACT_ADDRESSES.testnet.communityPool as `0x${string}`;

  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<'idle' | 'switching' | 'funding-gas' | 'approving' | 'depositing' | 'withdrawing' | 'complete' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pendingHash, setPendingHash] = useState<`0x${string}` | null>(null);
  // Keep the last successful tx hash visible after confirmation so users can
  // still click through to HashScan. pendingHash is nulled on confirm; this
  // survives the reset and clears when a new tx starts or after 30s.
  const [lastSuccessTx, setLastSuccessTx] = useState<`0x${string}` | null>(null);
  // Amount + action kind for the success card — surfaces "Deposited 100 USDC"
  // instead of "Complete" so the user has explicit dollar/action context.
  const [lastSuccessAmount, setLastSuccessAmount] = useState<string | null>(null);
  const [lastSuccessKind, setLastSuccessKind] = useState<'approve' | 'deposit' | 'withdraw' | null>(null);
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [faucetTx, setFaucetTx] = useState<string | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);

  // ─── Reads ─────────────────────────────────────────────────────────────
  const { data: usdcBalance, refetch: refetchBalance } = useReadContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { data: userShares, refetch: refetchShares } = useReadContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: 'sharesOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { data: totalShares } = useReadContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: 'totalShares',
    query: { enabled: true },
  });

  const { data: totalAssets } = useReadContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: 'totalAssets',
    query: { enabled: true },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, vault] : undefined,
    query: { enabled: !!address },
  });

  // Native HBAR balance — used to detect fresh Privy embedded wallets that
  // ship with 0 HBAR. Without HBAR, gas estimation at Hashio returns 400
  // and Privy surfaces the opaque 'Missing or invalid parameters' error.
  // onDeposit auto-drips the faucet when this reads below the threshold.
  const { data: hbarBalance, refetch: refetchHbarBalance } = useBalance({
    address,
    chainId: HEDERA_TESTNET_ID,
    query: { enabled: !!address },
  });

  // EIP-2612 permit nonce — Privy-signer path needs this to build the
  // typed message. Non-Privy users don't sign permits, so we only read
  // when the Privy path is active.
  const { data: permitNonce, refetch: refetchPermitNonce } = useReadContract({
    address: usdc,
    abi: PERMIT_TOKEN_ABI,
    functionName: 'nonces',
    args: address ? [address] : undefined,
    query: { enabled: !!address && isPrivySigner },
  });

  // ─── Writes ─────────────────────────────────────────────────────────────
  const { writeContractAsync } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: pendingHash ?? undefined,
  });

  // Refresh reads + parent when a tx confirms.
  useEffect(() => {
    if (!isConfirmed || !pendingHash) return;
    refetchBalance();
    refetchShares();
    refetchAllowance();
    onRefresh?.();
    // Snapshot the current status BEFORE we flip it to 'complete' so the
    // success card knows whether this was approve / deposit / withdraw.
    const kind: 'approve' | 'deposit' | 'withdraw' | null =
      status === 'approving' ? 'approve'
      : status === 'depositing' ? 'deposit'
      : status === 'withdrawing' ? 'withdraw'
      : null;
    setLastSuccessKind(kind);
    setLastSuccessAmount(amount || null);
    setStatus('complete');
    setAmount('');
    setLastSuccessTx(pendingHash);
    setPendingHash(null);
    const t = setTimeout(() => setStatus('idle'), 5000);
    const clr = setTimeout(() => {
      setLastSuccessTx(null);
      setLastSuccessAmount(null);
      setLastSuccessKind(null);
    }, 30_000);
    return () => { clearTimeout(t); clearTimeout(clr); };
  }, [isConfirmed, pendingHash, refetchBalance, refetchShares, refetchAllowance, onRefresh, status, amount]);

  // ─── Actions ───────────────────────────────────────────────────────────
  const ensureHederaChain = useCallback(async (): Promise<boolean> => {
    if (chainId === HEDERA_TESTNET_ID) return true;
    setStatus('switching');
    try {
      await switchChainAsync({ chainId: HEDERA_TESTNET_ID });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
      return false;
    }
  }, [chainId, switchChainAsync]);

  const onDeposit = useCallback(async () => {
    setError(null);
    if (!address) { setError('Sign in first.'); return; }
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) { setError('Enter an amount.'); return; }

    const okChain = await ensureHederaChain();
    if (!okChain) return;

    // Pre-flight HBAR check. Fresh Privy embedded wallets ship with 0 HBAR,
    // so the very first approve/deposit fails at Hashio's gas-estimate step
    // with an opaque 'Missing or invalid parameters' error. Auto-drip the
    // faucet so the user doesn't have to know about it. Threshold matches
    // the faucet's own HBAR_MIN_WEI (0.5 HBAR).
    const HBAR_MIN_WEI = 500_000_000_000_000_000n;
    const hbarWei = (hbarBalance?.value as bigint | undefined) ?? 0n;
    if (hbarWei < HBAR_MIN_WEI) {
      setStatus('funding-gas');
      try {
        const r = await fetch('/api/hedera/faucet', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address }),
        });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!r.ok || !j.ok) {
          setError(
            j.error?.includes('throttled')
              ? 'HBAR needed for gas. Faucet is throttled — try again in a few minutes, or fund manually.'
              : `Couldn't auto-fund HBAR for gas: ${j.error ?? `HTTP ${r.status}`}. Click Faucet to retry.`,
          );
          setStatus('error');
          return;
        }
        // Poll until Hashio's read layer sees the funded account. Faucet
        // already awaited wait(1), so consensus has the account — but
        // Mirror Node (which backs Hashio reads) lags 3-8s after finality.
        // Without polling here, the next tx signs against an address the
        // RPC still 404s on: "Requested resource not found. address '0x...'".
        const POLL_INTERVAL_MS = 1500;
        const POLL_TIMEOUT_MS = 20_000;
        const startedAt = Date.now();
        let visible = false;
        while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
          await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
          const res = await refetchHbarBalance();
          const v = (res.data?.value as bigint | undefined) ?? 0n;
          if (v >= HBAR_MIN_WEI) { visible = true; break; }
        }
        if (!visible) {
          setError('HBAR arrived but Hedera Mirror Node hasn\'t picked it up yet. Please try Deposit again in ~10 seconds.');
          setStatus('error');
          return;
        }
      } catch (e) {
        setError(`Couldn't auto-fund HBAR: ${e instanceof Error ? e.message : String(e)}`);
        setStatus('error');
        return;
      }
    }

    const amountWei = parseUnits(amount, USDC_DECIMALS);
    const need = amountWei;
    const have = (allowance as bigint | undefined) ?? 0n;
    // Max uint256 — approve once, deposit forever after. Trade-off:
    // gives the vault unlimited USDC allowance. Acceptable because the
    // vault is our own audited SimpleUsdcVault; the alternative (exact
    // per-deposit approve) forces users to sign 2 prompts EVERY deposit.
    const APPROVE_AMOUNT = (2n ** 256n) - 1n;

    try {
      // Approve step — first time only, unlimited allowance so future
      // deposits skip this leg.
      if (have < need) {
        setStatus('approving');
        const approveData = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [vault, APPROVE_AMOUNT],
        });
        // Privy path uses embedded-wallet provider directly (fixes MetaMask
        // hijack when both wallets present). Non-Privy path uses wagmi.
        // NOTE: we deliberately don't use depositWithPermit here — Privy's
        // sign modal renderer crashes on eth_signTypedData_v4 with
        // "Cannot destructure property 'method' of 'o.signMessage'" (chunk
        // 3263). Approve+deposit is 2 popups but works reliably.
        const approveHash = isPrivySigner && privySender
          ? (await privySender.sendTransaction({
              to: usdc,
              data: approveData,
              chainId: HEDERA_TESTNET_ID,
              title: `Approve ${amount} USDC`,
              description: `One-time approval so ZKward's Hedera pool can pull USDC for future deposits. Approving unlimited USDC to ${vault.slice(0, 8)}…${vault.slice(-4)}.`,
              gas: HASHIO_GAS_APPROVE,
              maxFeePerGas: HASHIO_MAX_FEE_PER_GAS,
              maxPriorityFeePerGas: HASHIO_PRIORITY_FEE,
            })).hash
          : await writeContractAsync({
              address: usdc,
              abi: erc20Abi,
              functionName: 'approve',
              args: [vault, APPROVE_AMOUNT],
              chainId: HEDERA_TESTNET_ID,
              gas: HASHIO_GAS_APPROVE,
              maxFeePerGas: HASHIO_MAX_FEE_PER_GAS,
              maxPriorityFeePerGas: HASHIO_PRIORITY_FEE,
            });
        setPendingHash(approveHash);
        await waitForTx(approveHash);
        await refetchAllowance();
      }

      setStatus('depositing');
      const depositData = encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'deposit',
        args: [amountWei],
      });
      const depositHash = isPrivySigner && privySender
        ? (await privySender.sendTransaction({
            to: vault,
            data: depositData,
            chainId: HEDERA_TESTNET_ID,
            title: `Deposit ${amount} USDC into ZKward`,
            description: `Deposits ${amount} USDC into the Hedera community pool. You receive shares proportional to the pool's current NAV.`,
            gas: HASHIO_GAS_DEPOSIT,
            maxFeePerGas: HASHIO_MAX_FEE_PER_GAS,
            maxPriorityFeePerGas: HASHIO_PRIORITY_FEE,
          })).hash
        : await writeContractAsync({
            address: vault,
            abi: VAULT_ABI,
            functionName: 'deposit',
            args: [amountWei],
            chainId: HEDERA_TESTNET_ID,
            gas: HASHIO_GAS_DEPOSIT,
            maxFeePerGas: HASHIO_MAX_FEE_PER_GAS,
            maxPriorityFeePerGas: HASHIO_PRIORITY_FEE,
          });
      setPendingHash(depositHash);
    } catch (e) {
      setError(shortErr(e));
      setStatus('error');
      setPendingHash(null);
    }
  }, [address, amount, allowance, hbarBalance, ensureHederaChain, usdc, vault, writeContractAsync, refetchAllowance, refetchHbarBalance, isPrivySigner, privySender]);

  const onWithdraw = useCallback(async () => {
    setError(null);
    if (!address) { setError('Sign in first.'); return; }
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) { setError('Enter shares to burn.'); return; }

    const okChain = await ensureHederaChain();
    if (!okChain) return;

    const sharesWei = parseUnits(amount, SHARES_DECIMALS);
    try {
      setStatus('withdrawing');
      const withdrawData = encodeFunctionData({
        abi: VAULT_ABI,
        functionName: 'withdraw',
        args: [sharesWei],
      });
      const hash = isPrivySigner && privySender
        ? (await privySender.sendTransaction({
            to: vault,
            data: withdrawData,
            chainId: HEDERA_TESTNET_ID,
            title: `Withdraw ${amount} shares from ZKward`,
            description: `Burns ${amount} pool shares and returns the proportional USDC to your wallet.`,
            gas: HASHIO_GAS_WITHDRAW,
            maxFeePerGas: HASHIO_MAX_FEE_PER_GAS,
            maxPriorityFeePerGas: HASHIO_PRIORITY_FEE,
          })).hash
        : await writeContractAsync({
            address: vault,
            abi: VAULT_ABI,
            functionName: 'withdraw',
            args: [sharesWei],
            chainId: HEDERA_TESTNET_ID,
            gas: HASHIO_GAS_WITHDRAW,
            maxFeePerGas: HASHIO_MAX_FEE_PER_GAS,
            maxPriorityFeePerGas: HASHIO_PRIORITY_FEE,
          });
      setPendingHash(hash);
    } catch (e) {
      setError(shortErr(e));
      setStatus('error');
    }
  }, [address, amount, ensureHederaChain, vault, writeContractAsync, isPrivySigner, privySender]);

  const onFaucet = useCallback(async () => {
    if (!address) return;
    setFaucetLoading(true);
    setError(null);
    setFaucetTx(null);
    try {
      const r = await fetch('/api/hedera/faucet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      const j = (await r.json()) as { ok?: boolean; txHash?: string; error?: string };
      if (!r.ok || !j.ok) {
        setError(j.error ?? `faucet HTTP ${r.status}`);
      } else if (j.txHash) {
        setFaucetTx(j.txHash);
        // Wait a beat for mirror indexer then refresh balance.
        await new Promise((res) => setTimeout(res, 1500));
        await refetchBalance();
      }
    } catch (e) {
      setError(shortErr(e));
    } finally {
      setFaucetLoading(false);
    }
  }, [address, refetchBalance]);

  // ─── Derived ────────────────────────────────────────────────────────────
  const humanUsdcBalance = usdcBalance
    ? Number(formatUnits(usdcBalance as bigint, USDC_DECIMALS))
    : 0;
  const humanShares = userShares ? Number(formatUnits(userShares as bigint, SHARES_DECIMALS)) : 0;
  const humanTotalAssets = totalAssets
    ? Number(formatUnits(totalAssets as bigint, USDC_DECIMALS))
    : 0;
  const humanTotalShares = totalShares ? Number(formatUnits(totalShares as bigint, SHARES_DECIMALS)) : 0;
  // Virtual-offset share price — both terms in the same 6-decimal
  // human space now that SHARES_DECIMALS === USDC_DECIMALS.
  const sharePrice = humanTotalShares > 0
    ? (humanTotalAssets + 1e-6) / (humanTotalShares + 1e-6)
    : 1;
  const userValueUsdc = humanShares * sharePrice;

  // Show HashScan link for in-flight tx OR the last successful one so users
  // can always click through to confirm on-chain finality.
  const explorer = pendingHash
    ? `https://hashscan.io/testnet/transaction/${pendingHash}`
    : lastSuccessTx
      ? `https://hashscan.io/testnet/transaction/${lastSuccessTx}`
      : null;

  const chainMismatch = address && chainId !== HEDERA_TESTNET_ID && status === 'idle';

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setAddressCopied(true);
      setTimeout(() => setAddressCopied(false), 1500);
    } catch { /* clipboard may be denied — no-op */ }
  };

  return (
    <div className="p-4 border-b border-gray-100 dark:border-gray-700 space-y-3">
      {/* Prominent wallet card — 'this is your USDC address on Hedera'. Users
          who receive USDC from an external source (exchange, another wallet)
          need to see this address clearly. Sits above the deposit UI so it's
          the first thing seen when landing on the pool tab. */}
      {address ? (
        <div className="rounded-xl border p-3 space-y-2" style={{ borderColor: `${HEDERA_ACCENT}30`, background: `${HEDERA_ACCENT}08` }}>
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: HEDERA_ACCENT }}>
              Your Hedera wallet · USDC lands here
            </div>
            <span className="text-[10px] text-label-tertiary">Hedera Testnet · chainId 296</span>
          </div>
          <NameAndAvatarRow address={address} />
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate font-mono text-[12px] text-label-primary tabular-nums">{address}</code>
            <button
              onClick={copyAddress}
              className="p-1.5 rounded-lg hover:bg-white/60 active:scale-[0.96] transition-all"
              title="Copy address"
              aria-label="Copy wallet address"
            >
              {addressCopied ? (
                <Check className="w-4 h-4 text-[#34C759]" />
              ) : (
                <Copy className="w-4 h-4 text-label-secondary" />
              )}
            </button>
            <a
              href={`https://hashscan.io/testnet/account/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded-lg hover:bg-white/60 active:scale-[0.96] transition-all"
              title="View on HashScan"
            >
              <ExternalLink className="w-4 h-4 text-label-secondary" />
            </a>
          </div>
          <div className="text-[11px] text-label-tertiary mt-1.5 leading-relaxed">
            Send USDC to this address to fund deposits, or use the <span className="font-medium">Faucet</span> button below for 100 test USDC.
          </div>
        </div>
      ) : privyStatus.authenticated && (privyStatus.isCreating || !privyStatus.ready) ? (
        <div className="rounded-xl border p-3 text-[12px] flex items-center gap-2" style={{ borderColor: `${HEDERA_ACCENT}30`, background: `${HEDERA_ACCENT}0d`, color: HEDERA_ACCENT }}>
          <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
          <span>Creating your Hedera-testnet embedded wallet… (~2-5s)</span>
        </div>
      ) : (
        <div className="rounded-xl border border-[#FF9500]/30 bg-[#FF9500]/10 p-3 text-[12px] text-[#B26400]">
          <AlertTriangle className="w-4 h-4 inline mr-1.5 -mt-0.5" />
          Sign in with email/Google/wallet to create your Hedera-testnet embedded wallet, then deposit here.
        </div>
      )}

      {/* Balance chips */}
      <div className="flex flex-wrap gap-2 text-[12px]">
        {address ? (
          <>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-system-bg-secondary">
              <Wallet className="w-3 h-3" />
              <span className="tabular-nums">{truncate(address)}</span>
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full" style={{ background: `${HEDERA_ACCENT}15`, color: HEDERA_ACCENT }}>
              <span className="tabular-nums font-semibold">{humanUsdcBalance.toFixed(2)} USDC</span>
            </span>
            {humanUsdcBalance < 1 && (
              <button
                onClick={onFaucet}
                disabled={faucetLoading}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[#0069D9]/10 text-[#0069D9] font-semibold hover:bg-[#0069D9]/15 active:scale-[0.98] disabled:opacity-60"
                title="Mint 100 test USDC to your wallet (testnet faucet)"
              >
                {faucetLoading ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Droplets className="w-3 h-3" />
                )}
                Faucet 100 USDC
              </button>
            )}
            {faucetTx && (
              <a
                href={`https://hashscan.io/testnet/transaction/${faucetTx}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[#34C759]/10 text-[#34C759] font-semibold hover:bg-[#34C759]/15"
              >
                <Check className="w-3 h-3" />
                Minted <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {humanShares > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[#34C759]/10 text-[#34C759] font-semibold">
                <span className="tabular-nums">{humanShares.toFixed(4)} shares</span>
                <span className="opacity-70">· ${userValueUsdc.toFixed(2)}</span>
              </span>
            )}
          </>
        ) : (
          <span className="text-label-tertiary">Sign in to see balance.</span>
        )}
      </div>

      {chainMismatch && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-[#FF9500]/10 border border-[#FF9500]/30">
          <AlertTriangle className="w-4 h-4 text-[#FF9500] flex-shrink-0" />
          <span className="text-[12px] text-[#B26400]">
            Your wallet is on chain {chainId}. Click Deposit/Withdraw and we&apos;ll switch to Hedera Testnet (296).
          </span>
        </div>
      )}

      {/* Mode toggle */}
      <div className="inline-flex rounded-[10px] bg-system-bg-secondary p-0.5">
        <button
          onClick={() => setMode('deposit')}
          className={`px-3 py-1.5 rounded-[8px] text-[12px] font-semibold transition-all ${
            mode === 'deposit' ? 'bg-white shadow-ios-1 text-label-primary' : 'text-label-tertiary'
          }`}
        >
          <Plus className="inline w-3 h-3 mr-1" />
          Deposit
        </button>
        <button
          onClick={() => setMode('withdraw')}
          className={`px-3 py-1.5 rounded-[8px] text-[12px] font-semibold transition-all ${
            mode === 'withdraw' ? 'bg-white shadow-ios-1 text-label-primary' : 'text-label-tertiary'
          }`}
        >
          <Minus className="inline w-3 h-3 mr-1" />
          Withdraw
        </button>
      </div>

      {/* Amount + action */}
      {(() => {
        const parsedAmount = Number(amount);
        const amountEntered = Number.isFinite(parsedAmount) && parsedAmount > 0;
        const insufficientBalance = mode === 'deposit' && amountEntered && parsedAmount > humanUsdcBalance;
        const insufficientShares = mode === 'withdraw' && amountEntered && parsedAmount > humanShares;
        const busy = (status !== 'idle' && status !== 'complete' && status !== 'error') || isConfirming;

        const disabledReason: string | null =
          !address ? 'Sign in first' :
          !amountEntered ? (mode === 'deposit' ? 'Enter USDC amount' : 'Enter share amount') :
          insufficientBalance ? `Only ${humanUsdcBalance.toFixed(2)} USDC available — use Faucet ↑` :
          insufficientShares ? `Only ${humanShares.toFixed(4)} shares available` :
          busy ? 'Working…' :
          null;

        return (
          <div className="space-y-1.5 min-w-0">
            <div className="flex gap-2 min-w-0">
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={mode === 'deposit' ? 'USDC amount' : `Max ${humanShares.toFixed(2)}`}
                disabled={busy}
                className="flex-1 min-w-0 h-11 px-3 rounded-[10px] border border-black/10 dark:border-white/15 bg-system-bg-secondary tabular-nums focus:outline-none"
              />
              {mode === 'withdraw' && humanShares > 0 && (
                <button
                  onClick={() => setAmount(humanShares.toString())}
                  className="flex-shrink-0 px-3 h-11 rounded-[10px] bg-system-bg-secondary text-[12px] font-medium text-label-secondary hover:bg-[#E5E5EA] active:scale-[0.98]"
                >
                  Max
                </button>
              )}
              <button
                onClick={mode === 'deposit' ? onDeposit : onWithdraw}
                disabled={disabledReason !== null}
                className="flex-shrink-0 h-11 px-4 sm:px-5 rounded-[10px] text-white font-semibold text-[13px] sm:text-[14px] active:scale-[0.98] disabled:opacity-60 flex items-center gap-1.5 min-w-[92px] sm:min-w-[120px] justify-center"
                style={{ background: mode === 'deposit' ? ACCENT : '#FF3B30' }}
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                {status === 'complete' && <Check className="w-4 h-4" />}
                {status === 'idle' && <>{mode === 'deposit' ? 'Deposit' : 'Withdraw'}</>}
                {status === 'switching' && 'Switching…'}
                {status === 'funding-gas' && 'Funding HBAR…'}
                {status === 'approving' && 'Approving…'}
                {status === 'depositing' && 'Depositing…'}
                {status === 'withdrawing' && 'Withdrawing…'}
                {status === 'complete' && 'Done'}
                {status === 'error' && 'Retry'}
              </button>
            </div>
            {disabledReason && (
              <div className="text-[11px] text-label-tertiary">{disabledReason}</div>
            )}
            {/* Post-confirm success card — surfaces amount + tx hash + HashScan
                link prominently so users see WHAT they did AND on-chain proof. */}
            {status === 'complete' && lastSuccessTx && (
              <div className="mt-2 p-3 rounded-[10px] bg-[#34C759]/10 border border-[#34C759]/30">
                <div className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-green-700 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0 text-[12px]">
                    <div className="font-medium text-green-700">
                      {lastSuccessKind === 'approve' && lastSuccessAmount
                        ? `Approved ${lastSuccessAmount} USDC — depositing next`
                        : lastSuccessKind === 'deposit' && lastSuccessAmount
                          ? `Deposited ${lastSuccessAmount} USDC into the pool`
                          : lastSuccessKind === 'withdraw' && lastSuccessAmount
                            ? `Withdrew ${lastSuccessAmount} shares from the pool`
                            : 'Transaction confirmed on Hedera'}
                    </div>
                    <div className="mt-0.5 text-label-secondary break-all font-mono text-[11px]">
                      {lastSuccessTx.slice(0, 18)}…{lastSuccessTx.slice(-16)}
                    </div>
                    <a
                      href={`https://hashscan.io/testnet/transaction/${lastSuccessTx}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-[#0069D9] hover:underline text-[11px] font-medium"
                    >
                      View on HashScan <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Status + tx link */}
      <div className="text-[11px] text-label-tertiary flex flex-wrap gap-x-2 gap-y-1">
        <span>
          Share price: <span className="tabular-nums font-medium text-label-secondary">${sharePrice.toFixed(6)} USDC</span>
        </span>
        <span>·</span>
        <span>
          Pool TVL: <span className="tabular-nums font-medium text-label-secondary">${humanTotalAssets.toFixed(2)}</span>
        </span>
        {explorer && (
          <a href={explorer} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-[#0069D9] hover:underline">
            View tx <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {error && (
        <div className="text-[11px] text-[#FF3B30] break-words">{error}</div>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function shortErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // wagmi's error messages are verbose; keep the first line for the toast.
  return msg.split('\n')[0].slice(0, 200);
}

async function waitForTx(hash: `0x${string}`, maxWaitMs = 30_000): Promise<void> {
  // Lightweight polling receipt-wait — dedicated to the inline approve→deposit
  // chain. Uses Hashio public RPC directly to avoid pulling in a whole ethers
  // provider just for one call.
  const url = 'https://testnet.hashio.io/api';
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [hash],
        }),
      });
      const j = (await r.json()) as { result?: { status?: string } | null };
      if (j.result && j.result.status === '0x1') return;
      if (j.result && j.result.status === '0x0') throw new Error('approve reverted');
    } catch { /* poll again */ }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('approve tx timed out');
}

/**
 * NameAndAvatarRow — shows the user's avatar + current display name (or
 * "Set your name" prompt) inside the wallet card. Click Pencil to edit
 * inline. Uses the shared useWalletProfile hook so editing here OR in
 * ProfileTab keeps every mounted surface in sync via React Query cache
 * invalidation.
 */
function NameAndAvatarRow({ address }: { address: `0x${string}` }) {
  const { data } = useWalletProfile(address);
  const setProfile = useSetWalletProfile();
  const name = data?.displayName ?? null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const saving = setProfile.isPending;

  // Keep draft in sync when the cached name updates (external edit).
  useEffect(() => { if (!editing) setDraft(name ?? ''); }, [name, editing]);

  const onSave = async () => {
    const trimmed = draft.trim();
    if (trimmed.length < 1 || trimmed.length > 32) {
      setErr('1-32 characters');
      return;
    }
    setErr(null);
    const res = await setProfile.mutateAsync({ address, displayName: trimmed });
    if (!res.ok) setErr(res.error ?? 'save failed');
    else setEditing(false);
  };

  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <WalletAvatar address={address} name={name} size={36} />
      {editing ? (
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSave();
              if (e.key === 'Escape') { setEditing(false); setDraft(name ?? ''); setErr(null); }
            }}
            maxLength={32}
            placeholder="Your name (max 32)"
            disabled={saving}
            className="flex-1 min-w-0 h-8 px-2 rounded-md border border-black/10 bg-white text-[13px] focus:outline-none focus:ring-1 focus:ring-black/20"
          />
          <button
            onClick={onSave}
            disabled={saving || draft.trim().length < 1}
            className="flex-shrink-0 h-8 px-2.5 rounded-md text-[12px] font-semibold text-white active:scale-[0.97] disabled:opacity-60"
            style={{ background: HEDERA_ACCENT }}
          >
            {saving ? '…' : 'Save'}
          </button>
        </div>
      ) : (
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <span className="flex-1 min-w-0 truncate text-[13px] font-semibold text-label-primary">
            {name ?? <span className="text-label-tertiary font-normal">No display name set</span>}
          </span>
          <button
            onClick={() => { setEditing(true); setDraft(name ?? ''); setErr(null); }}
            className="flex-shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-md text-[11px] font-medium text-label-secondary hover:bg-white/60 active:scale-[0.97]"
            title={name ? 'Change your name' : 'Set your display name'}
          >
            <Pencil className="w-3 h-3" />
            {name ? 'Edit' : 'Set name'}
          </button>
        </div>
      )}
      {err && <span className="text-[10px] text-[#FF3B30]">{err}</span>}
    </div>
  );
}
