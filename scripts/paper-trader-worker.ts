#!/usr/bin/env bun
/**
 * Standalone paper-trader worker. Replaces the Vercel cron route.
 *
 * Runs one tick of PaperTrader (-3) + PaperGatedTrader (-4) then exits.
 * Invoke every 5 min from jobs.zkward.com (SSH exec or local HTTP call
 * to a supervisor process). Doesn't require Vercel, doesn't count
 * against Vercel function invocations.
 *
 * ## Why standalone
 *
 * Vercel Hobby tier hit fair-use limits 2026-09-23 with 15 crons ×
 * multiple portfolios firing every 2-30 min. Every invocation is a
 * function call, and jobs.zkward.com hitting Vercel routes became the
 * biggest single contributor. Moving the trader off Vercel restores
 * the invocation budget for user-facing routes (dashboard, chat, API).
 *
 * ## Env requirements
 *
 * Minimum: DATABASE_URL (Bakchodi PG) + whatever the aggregator needs
 * (crypto.com key, polymarket, delphi tokens if any). Same env as the
 * Vercel deployment; source from .env.local when running locally, or
 * export before invocation on the Bakchodi host.
 *
 * ## Exit codes
 *
 *   0 = both traders ticked (may still have skipped due to gates)
 *   1 = at least one trader threw an unhandled error
 *   2 = env misconfigured (bail early, no tick)
 */
import { execFileSync } from 'node:child_process';
import { PaperTrader } from '@/lib/services/paper-trader/PaperTrader';
import { PaperGatedTrader } from '@/lib/services/paper-trader/PaperGatedTrader';
import { logger } from '@/lib/utils/logger';
import { closePool } from '@/lib/db/postgres';

/**
 * Fetch latest main and hard-reset the checkout so the next `bun run`
 * picks up whatever was just pushed. This is what makes the trader
 * auto-deploy on `git push origin main` — no SSH required.
 *
 * Best-effort: if pull fails (offline, diverged, permission), log a
 * warning and continue with whatever code is currently checked out.
 * A single stale tick beats halting the trader over a network blip.
 *
 * Disable per-tick pull with PAPER_TRADER_AUTO_PULL=0. Useful when
 * running the worker off a local dev branch or during a manual bisect.
 */
function autoPullMain() {
  if (process.env.PAPER_TRADER_AUTO_PULL === '0') return;
  try {
    // --ff-only refuses to merge if the local checkout has diverged.
    // A dev's uncommitted work stays put — pull is skipped, warning logged.
    const out = execFileSync('git', ['pull', '--ff-only', 'origin', 'main'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    });
    if (out && !out.includes('Already up to date')) {
      logger.info('[worker] auto-pull fetched new commits', { out: out.trim().slice(0, 200) });
    }
  } catch (e) {
    logger.warn('[worker] auto-pull failed (continuing with current code)', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function main() {
  const startedAt = Date.now();
  if (!process.env.DATABASE_URL && !process.env.PROD_DATABASE_URL) {
    console.error('[worker] DATABASE_URL / PROD_DATABASE_URL not set — bailing');
    process.exit(2);
  }
  autoPullMain();
  // Prefer PROD when the local tunnel is down. Worker code shouldn't
  // silently fall through to a local dev DB.
  if (!process.env.DATABASE_URL && process.env.PROD_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.PROD_DATABASE_URL;
    logger.info('[worker] using PROD_DATABASE_URL (DATABASE_URL not set)');
  }

  let ok = true;

  logger.info('[worker] tick start', { pid: process.pid, node: process.version });

  // Effective-config dump (Fix O, 2026-09-27). The worker host's own env
  // silently overrides code defaults — Fix J raised the conf gate to 70 in
  // code while conf 65-68 entries kept appearing in prod, and nothing
  // logged which value was actually live. One line makes every future
  // "the fix changed nothing" diagnosable at a glance.
  try {
    const cfg = await import('@/lib/services/paper-trader/config');
    let sha = 'unknown';
    try {
      sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8', timeout: 5_000,
      }).trim();
    } catch { /* non-fatal */ }
    logger.info('[worker] effective config', {
      sha,
      universe: cfg.PAPER_UNIVERSE.join(','),
      minConfidence: cfg.PAPER_MIN_CONFIDENCE,
      minConsensus: cfg.PAPER_MIN_CONSENSUS,
      minSources: cfg.PAPER_MIN_SOURCES,
      stakePct: cfg.PAPER_STAKE_PCT,
      maxStakePct: cfg.PAPER_MAX_STAKE_PCT,
      leverage: cfg.PAPER_LEVERAGE,
      stopLossPctEnv: process.env.PAPER_TRADER_STOP_LOSS_PCT ?? '(default)',
      maxHoldMin: cfg.PAPER_MAX_HOLD_MIN,
      maxHoldCeilingMin: cfg.PAPER_MAX_HOLD_CEILING_MIN,
      tightenAgeMin: cfg.PAPER_TIGHTEN_AGE_MIN,
      tightenNotionalFrac: cfg.PAPER_TIGHTEN_NOTIONAL_FRAC,
      trailingArmNotionalFrac: cfg.PAPER_TRAILING_ARM_NOTIONAL_FRAC,
      minFlipAgeSec: cfg.PAPER_MIN_FLIP_AGE_SEC,
      minStableTicks: cfg.PAPER_MIN_STABLE_TICKS,
      minMajorityPct: cfg.PAPER_MIN_MAJORITY_PCT,
      haltEntriesInChop: cfg.PAPER_HALT_ENTRIES_IN_CHOP,
      chopStakeMult: cfg.PAPER_CHOP_STAKE_MULT,
      probeStakeMult: cfg.PAPER_PROBE_STAKE_MULT,
      skipStrong: cfg.PAPER_SKIP_STRONG_SIGNALS,
      disableHalts: cfg.PAPER_DISABLE_HALTS,
      calibratedMinWinRate: cfg.PAPER_CALIBRATED_MIN_WIN_RATE,
      calibratedRankMinN: cfg.PAPER_CALIBRATED_RANK_MIN_N,
      blacklistSeeds: [...cfg.PAPER_ASSET_SIDE_BLACKLIST_SEEDS].join(','),
      maxConcurrent: cfg.PAPER_MAX_CONCURRENT,
    });
  } catch (e) {
    logger.warn('[worker] config dump failed (non-fatal)', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  try {
    const r = await PaperTrader.runTick();
    logger.info('[worker] PaperTrader tick complete', { result: r });
  } catch (e) {
    ok = false;
    logger.error('[worker] PaperTrader.runTick threw', e instanceof Error ? e : new Error(String(e)));
  }

  try {
    const r = await PaperGatedTrader.runTick();
    logger.info('[worker] PaperGatedTrader tick complete', { result: r });
  } catch (e) {
    ok = false;
    logger.error('[worker] PaperGatedTrader.runTick threw', e instanceof Error ? e : new Error(String(e)));
  }

  const durationMs = Date.now() - startedAt;
  logger.info('[worker] tick done', { durationMs, ok });

  // Explicit pool close so the process actually exits (open pg connections
  // keep the event loop alive otherwise).
  await closePool().catch(() => {});
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[worker] fatal', e);
  process.exit(1);
});
