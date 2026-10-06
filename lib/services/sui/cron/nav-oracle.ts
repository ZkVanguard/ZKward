/**
 * External NAV oracle + admin operations.
 *
 * `attestExternalNav` is the every-30-min NAV push (v0.4.0 OracleCap-aware);
 * `aiDrivenResetDailyHedge` bumps the on-chain daily-hedge counter under
 * strict AI-signal + budget guards. Both are AdminCap/OracleCap-gated
 * Move calls that need cron_state + Discord alerting. Extracted from
 * hedge-treasury.ts on 2026-07-19.
 */
import { logger } from '@/lib/utils/logger';
import {
  SUI_USDC_POOL_CONFIG,
  SUI_USDC_COIN_TYPE,
} from '@/lib/services/sui/SuiCommunityPoolService';
import { isStrongHedgeSignal } from '@/lib/services/sui/cron/signal-gating';
import { getCronStateOr, setCronState } from '@/lib/db/cron-state';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { attestPath } from '@/lib/services/sui/cron/onchain-math';


/**
 * Push the off-chain NAV portion to the Move contract's oracle field so
 * deposit/withdraw share math reflects true pool value.
 *
 * external_nav_usdc = navUsd_total - balance_onchain_usdc
 *
 * Deposits and withdrawals are priced on `balance + external`
 * (total_assets_including_external in the Move source); nothing else is
 * added. USDC that left the pool through open_hedge sits in the admin wallet
 * or on the venue, and navUsdTotal already counts it there, so it belongs in
 * the external figure. Subtracting hedge_state.total_hedged_value as well, as
 * this did until 2026-10-06, left that value out of every share price: a
 * withdrawer was underpaid and a depositor over-issued by the hedged amount.
 * (get_total_nav does add the hedged value; it is a view used for ratios,
 * and reads high by that amount while a hedge is open.)
 *
 * A change of more than 30% cannot be attested in one call. It is walked
 * there in one transaction (see attestPath), but only once the same target
 * has been seen on LARGE_CHANGE_CONFIRMATIONS consecutive ticks, so a single
 * bad read cannot reprice the pool.
 *
 * Returns pushed:false on any error. With strict mode on, the contract then
 * refuses deposits and withdrawals once the last attestation is two hours
 * old; `attestationAgeMin` lets the caller alert before that.
 */
const EXTERNAL_NAV_KEY = 'external_nav_usdc';
const EXTERNAL_NAV_TS_KEY = 'external_nav_ts_ms';
const PENDING_KEY = 'sui-nav-attest:pending-large-change';
const LARGE_CHANGE_CONFIRMATIONS = 3;
const SAME_TARGET_TOLERANCE = 0.05;
/** A single attestation costs about 0.0002 SUI. The budget must stay under the wallet balance or the node rejects the transaction outright. */
const ATTEST_GAS_BASE = 2_000_000;
const ATTEST_GAS_PER_STEP = 1_000_000;

interface PendingLargeChange { targetRaw: string; count: number; firstSeen: number }

export interface AttestResult {
  pushed: boolean;
  externalNavUsd?: number;
  txDigest?: string;
  error?: string;
  /** Age of the attestation on chain before this call, in minutes. */
  attestationAgeMin?: number;
  /** How many attestations the transaction carried (more than one means a stepped catch-up). */
  steps?: number;
}

export async function attestExternalNav(
  network: 'mainnet' | 'testnet',
  navUsdTotal: number,
): Promise<AttestResult> {
  const adminKey = (process.env.SUI_POOL_ADMIN_KEY || process.env.BLUEFIN_PRIVATE_KEY || '').trim();
  // v0.4.0: prefer OracleCap so cron survives AdminCap → MSafe migration.
  // Falls back to AdminCap for pre-v0.4.0 packages / pre-migration pools.
  const oracleCapId = (process.env.SUI_ORACLE_CAP_ID || '').trim();
  const adminCapId = (process.env.SUI_ADMIN_CAP_ID || '').trim();
  const capId = oracleCapId || adminCapId;
  const capKind: 'oracle' | 'admin' = oracleCapId ? 'oracle' : 'admin';
  const attestFn = capKind === 'oracle' ? 'oracle_attest_external_nav' : 'admin_attest_external_nav';
  const poolConfig = SUI_USDC_POOL_CONFIG[network];
  if (!adminKey || !capId || !poolConfig.packageId || !poolConfig.poolStateId) {
    return { pushed: false, error: 'missing admin key, OracleCap/AdminCap, or pool config' };
  }

  try {
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const { Transaction } = await import('@mysten/sui/transactions');
    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');

    const keypair = adminKey.startsWith('suiprivkey')
      ? Ed25519Keypair.fromSecretKey(adminKey)
      : Ed25519Keypair.fromSecretKey(Buffer.from(adminKey.replace(/^0x/, ''), 'hex'));
    const suiClient = createFailoverSuiClient(network);

    // Read on-chain balance + hedge_state from the pool object so we
    // compute the external portion correctly. Cron's navUsdTotal already
    // includes everything; subtracting these gives the bit that lives
    // off-chain.
    const obj = await suiClient.getObject({ id: poolConfig.poolStateId!, options: { showContent: true } });
    const fields = (obj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields ?? {};
    const balanceRaw = Number((fields as { balance?: string }).balance ?? 0);
    if ((fields as { balance?: unknown }).balance === undefined) {
      return { pushed: false, error: 'pool object unreadable — skipping attestation' };
    }
    const balanceUsd = balanceRaw / 1e6;

    const externalNavUsd = Math.max(0, navUsdTotal - balanceUsd);
    const externalNavRaw = Math.floor(externalNavUsd * 1e6); // USDC has 6 decimals

    // What is on chain now: the value the 30% bound is measured from, and its age.
    const dynamicField = async (key: string): Promise<string | undefined> => {
      const res = await suiClient.getDynamicFieldObject({
        parentId: poolConfig.poolStateId!,
        name: { type: 'vector<u8>', value: Array.from(Buffer.from(key)) },
      });
      if (res.error) {
        if (res.error.code === 'dynamicFieldNotFound') return undefined;
        throw new Error(`${key} read failed: ${res.error.code}`);
      }
      const value = (res.data?.content as { fields?: { value?: unknown } } | undefined)?.fields?.value;
      if (value === undefined) throw new Error(`${key} has no value`);
      return String(value);
    };
    const [priorStr, tsStr] = await Promise.all([dynamicField(EXTERNAL_NAV_KEY), dynamicField(EXTERNAL_NAV_TS_KEY)]);
    const priorRaw = BigInt(priorStr ?? '0');
    const attestationAgeMin = tsStr ? (Date.now() - Number(tsStr)) / 60_000 : undefined;

    const path = attestPath(priorRaw, BigInt(externalNavRaw));
    if (!path) {
      return { pushed: false, attestationAgeMin, error: `external NAV ${externalNavUsd.toFixed(2)} cannot be reached from ${(Number(priorRaw) / 1e6).toFixed(2)} within the 30% bound` };
    }
    if (path.length > 1) {
      const pending = await getCronStateOr<PendingLargeChange | null>(PENDING_KEY, null);
      const pendingTarget = pending ? Number(pending.targetRaw) : 0;
      const sameTarget = !!pending && pendingTarget > 0 && Math.abs(externalNavRaw - pendingTarget) <= pendingTarget * SAME_TARGET_TOLERANCE;
      const count = sameTarget ? pending!.count + 1 : 1;
      if (count < LARGE_CHANGE_CONFIRMATIONS) {
        await setCronState(PENDING_KEY, { targetRaw: String(externalNavRaw), count, firstSeen: sameTarget ? pending!.firstSeen : Date.now() });
        if (count === 1) {
          await notifyDiscord(
            `External NAV wants to move from $${(Number(priorRaw) / 1e6).toFixed(2)} to $${externalNavUsd.toFixed(2)}, more than 30%. Not attesting until it reads the same on ${LARGE_CHANGE_CONFIRMATIONS} ticks in a row.`,
            'WARN',
            { chain: 'sui', priorUsd: (Number(priorRaw) / 1e6).toFixed(2), targetUsd: externalNavUsd.toFixed(2), navUsdTotal: navUsdTotal.toFixed(2) },
          ).catch(() => {});
        }
        return { pushed: false, attestationAgeMin, error: `large change awaiting confirmation (${count}/${LARGE_CHANGE_CONFIRMATIONS})` };
      }
    }

    // Cap ownership check — cron gracefully no-ops when the cap has
    // been transferred (e.g. AdminCap → MSafe). Post-v0.4.0 migration,
    // OracleCap stays on the hot key so cron continues while AdminCap
    // is cold; the no-op branch only fires if BOTH caps are cold.
    const capObj = await suiClient.getObject({ id: capId, options: { showOwner: true } });
    const capOwner = capObj.data?.owner;
    const cronSigner = keypair.toSuiAddress();
    if (!capOwner || typeof capOwner !== 'object' || !('AddressOwner' in capOwner)) {
      return { pushed: false, error: `${capKind === 'oracle' ? 'OracleCap' : 'AdminCap'} owner unreadable — skipping attestation` };
    }
    if (capOwner.AddressOwner.toLowerCase() !== cronSigner.toLowerCase()) {
      return { pushed: false, error: `${capKind === 'oracle' ? 'OracleCap' : 'AdminCap'} is not held by cron signer (owner=${capOwner.AddressOwner.slice(0, 12)}…) — cannot attest.` };
    }

    const gasBudget = ATTEST_GAS_BASE + ATTEST_GAS_PER_STEP * path.length;
    const gas = await suiClient.getBalance({ owner: cronSigner });
    if (BigInt(gas.totalBalance) < BigInt(gasBudget)) {
      return { pushed: false, attestationAgeMin, error: `insufficient gas: signer holds ${(Number(gas.totalBalance) / 1e9).toFixed(4)} SUI, attestation needs ${(gasBudget / 1e9).toFixed(4)}` };
    }

    const tx = new Transaction();
    const usdcType = SUI_USDC_COIN_TYPE[network];
    for (const stepRaw of path) {
      tx.moveCall({
        target: `${poolConfig.packageId}::${poolConfig.moduleName}::${attestFn}`,
        typeArguments: [usdcType],
        arguments: [
          tx.object(capId),
          tx.object(poolConfig.poolStateId!),
          tx.pure.u64(stepRaw),
          tx.object('0x6'),
        ],
      });
    }
    tx.setGasBudget(gasBudget);

    const result = await suiClient.signAndExecuteTransaction({
      signer: keypair, transaction: tx, options: { showEffects: true },
    });
    const ok = result.effects?.status?.status === 'success';
    if (ok) {
      logger.info('[SUI Cron] External NAV attested', {
        capKind,
        attestFn,
        externalNavUsd: externalNavUsd.toFixed(2),
        balanceUsd: balanceUsd.toFixed(2),
        navUsdTotal: navUsdTotal.toFixed(2),
        steps: path.length,
        txDigest: result.digest,
      });
      if (path.length > 1) {
        await setCronState(PENDING_KEY, null).catch(() => {});
        await notifyDiscord(
          `External NAV caught up from $${(Number(priorRaw) / 1e6).toFixed(2)} to $${externalNavUsd.toFixed(2)} in ${path.length} steps in one transaction.`,
          'WARN',
          { chain: 'sui', txDigest: result.digest, steps: path.length },
        ).catch(() => {});
      }
      return { pushed: true, externalNavUsd, txDigest: result.digest, attestationAgeMin, steps: path.length };
    }
    const errStr = result.effects?.status?.error || 'unknown';
    // E_EXTERNAL_NAV_CHANGE_TOO_LARGE is an expected reversion (anti-
    // manipulation guard); just warn and let the next tick try again.
    if (errStr.includes('30,') || errStr.includes('E_EXTERNAL_NAV_CHANGE_TOO_LARGE')) {
      logger.warn('[SUI Cron] External NAV attestation rejected — change > 30%', {
        externalNavUsd: externalNavUsd.toFixed(2), error: errStr,
      });
      return { pushed: false, attestationAgeMin, error: 'change > 30% guard' };
    }
    logger.warn('[SUI Cron] External NAV attestation tx failed', { error: errStr, txDigest: result.digest });
    return { pushed: false, attestationAgeMin, error: errStr, txDigest: result.digest };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[SUI Cron] External NAV attestation threw', { error: msg });
    return { pushed: false, error: msg };
  }
}


/**
 * AI-driven on-chain daily-cap reset.
 *
 * The Move contract caps `daily_hedge_total` at 50% of NAV per UTC day to
 * prevent runaway hedge spend. That cap is too restrictive when the AI +
 * prediction-market signal flips strongly mid-day: the pool sits idle until
 * midnight UTC instead of acting on a high-confidence directional move.
 *
 * `admin_reset_daily_hedge(AdminCap, &mut state, &Clock)` zeros the counter
 * without touching active positions. We invoke it sparingly — only when the
 * AI says it's worth the additional risk — and we cap usage to a small
 * number per UTC day so a buggy or compromised signal source can't drain
 * the pool.
 *
 * Reset is allowed when ALL hold:
 *   • on-chain dailyHedgedToday >= 50% of NAV (cap actually exhausted)
 *   • AI urgency in {HIGH, CRITICAL} OR confidence >= 75
 *   • resets-used-today < HEDGE_DAILY_MAX_RESETS (default 4)
 */

export async function aiDrivenResetDailyHedge(
  network: 'mainnet' | 'testnet',
  signal: { urgency?: string; confidence?: number },
): Promise<{ reset: boolean; reason?: string; txDigest?: string; error?: string; resetsUsed?: number }> {
  const adminKey = (process.env.SUI_POOL_ADMIN_KEY || process.env.BLUEFIN_PRIVATE_KEY || '').trim();
  const adminCapId = (process.env.SUI_ADMIN_CAP_ID || '').trim();
  const poolConfig = SUI_USDC_POOL_CONFIG[network];

  if (!adminKey) return { reset: false, reason: 'no admin key' };
  if (!adminCapId) return { reset: false, reason: 'SUI_ADMIN_CAP_ID not configured' };
  if (!poolConfig.packageId || !poolConfig.poolStateId) {
    return { reset: false, reason: 'pool not configured' };
  }

  const urgency = (signal.urgency || '').toUpperCase();
  const confidence = Number(signal.confidence || 0);
  const minConfidence = Number(process.env.HEDGE_RESET_MIN_CONFIDENCE || 75);
  if (!isStrongHedgeSignal(urgency, confidence, minConfidence)) {
    return { reset: false, reason: `weak signal (urgency=${urgency || 'NONE'} conf=${confidence})` };
  }

  // Bound resets per UTC day so the cap still has teeth.
  const dayKey = `hedgeDailyReset:${Math.floor(Date.now() / 86_400_000)}`;
  const maxResets = Number(process.env.HEDGE_DAILY_MAX_RESETS || 4);
  const usedSoFar = await getCronStateOr<number>(dayKey, 0);
  if (usedSoFar >= maxResets) {
    return { reset: false, reason: `reset budget exhausted (${usedSoFar}/${maxResets})`, resetsUsed: usedSoFar };
  }

  try {
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const { Transaction } = await import('@mysten/sui/transactions');
    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');

    const keypair = adminKey.startsWith('suiprivkey')
      ? Ed25519Keypair.fromSecretKey(adminKey)
      : Ed25519Keypair.fromSecretKey(Buffer.from(adminKey.replace(/^0x/, ''), 'hex'));
    const suiClient = createFailoverSuiClient(network);

    // Pre-flight: confirm the cron's hot key still owns the AdminCap.
    // Once the cap is transferred to the MSafe multisig, the cron MUST stop
    // attempting auto-resets (each tx would fail noisily and burn gas budget).
    // We treat "not owned" as a clean no-op: daily cap acts as hard-stop until
    // a human runs collect-fees / reset via the multisig.
    const capObj = await suiClient.getObject({ id: adminCapId, options: { showOwner: true } });
    const capOwner = capObj.data?.owner;
    const cronSigner = keypair.toSuiAddress();
    if (!capOwner || typeof capOwner !== 'object' || !('AddressOwner' in capOwner)) {
      return { reset: false, reason: 'AdminCap owner unreadable — skipping auto-reset' };
    }
    if (capOwner.AddressOwner.toLowerCase() !== cronSigner.toLowerCase()) {
      return {
        reset: false,
        reason: `AdminCap owned by ${capOwner.AddressOwner} (not cron signer ${cronSigner}) — multisig-gated, daily cap is hard-stop`,
      };
    }

    const tx = new Transaction();
    const usdcType = SUI_USDC_COIN_TYPE[network];
    tx.moveCall({
      target: `${poolConfig.packageId}::${poolConfig.moduleName}::admin_reset_daily_hedge`,
      typeArguments: [usdcType],
      arguments: [
        tx.object(adminCapId),
        tx.object(poolConfig.poolStateId!),
        tx.object('0x6'),
      ],
    });
    tx.setGasBudget(20_000_000);

    const result = await suiClient.signAndExecuteTransaction({
      signer: keypair, transaction: tx, options: { showEffects: true },
    });
    const ok = result.effects?.status?.status === 'success';
    if (ok) {
      await setCronState(dayKey, usedSoFar + 1);
      logger.info('[SUI Cron] AI-driven daily-cap reset SUCCESS', {
        urgency, confidence, resetsUsed: usedSoFar + 1, maxResets, txDigest: result.digest,
      });
      await notifyDiscord(
        `Daily hedge cap RESET (${usedSoFar + 1}/${maxResets} resets used today, urgency=${urgency}, conf=${confidence}). Pool can now hedge again before UTC midnight.`,
        'WARN',
        { network, urgency, confidence, resetsUsed: usedSoFar + 1, maxResets, txDigest: result.digest },
      );
      return { reset: true, txDigest: result.digest, resetsUsed: usedSoFar + 1 };
    }
    logger.warn('[SUI Cron] AI-driven daily-cap reset FAILED', {
      error: result.effects?.status?.error,
    });
    return { reset: false, reason: 'tx failed', error: result.effects?.status?.error };
  } catch (err) {
    return { reset: false, reason: 'exception', error: err instanceof Error ? err.message : String(err) };
  }
}
