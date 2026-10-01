/**
 * Playwright E2E for the Solana pool UI (browser-level, headless chromium).
 *
 * Not a jest test — run directly: `bun test/integration/solana-pool-ui.pw.ts`
 * against a running server (BASE_URL env, default local prod server :3113).
 * Asserts the dashboard's Solana pool chain renders live state end-to-end
 * (status API → DOM), the wallet CTA exists, the on-chain deposit trail is
 * linked, and the API surface validates input. Wallet signing itself can't
 * run headless (no extension) — that path is covered by the scripted
 * user-journey E2E.
 */
import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3113').replace(/\/$/, '');
const SHOT = process.env.PW_SHOT || '';

function fail(msg: string): never {
  console.error('FAIL:', msg);
  process.exit(1);
}
const ok = (msg: string) => console.log('  ✓', msg);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // ── Pool tab, Solana chain, renders live state ──
  const resp = await page.goto(`${BASE}/en/dashboard?chain=solana`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (!resp || resp.status() >= 400) fail(`/en/dashboard?chain=solana HTTP ${resp?.status()}`);
  await page.waitForSelector('main h1:has-text("Pool")', { timeout: 20_000 });
  ok('Pool tab renders');

  await page.waitForSelector('text=/Solana Token Pool · Testnet/i', { timeout: 20_000 });
  ok('Solana chain selected (testnet)');

  // Live pool state populated from the status API (not placeholders)
  await page.waitForSelector('text=Pool value', { timeout: 20_000 });
  const members = await page.locator('text=/Pool Members?/').first().textContent({ timeout: 15_000 });
  if (!members) fail('pool stats not rendered');
  ok('pool stats rendered');

  await page.waitForSelector('button:has-text("Connect Solana wallet")', { timeout: 10_000 });
  ok('wallet connect CTA present in the pool tab');

  await page.waitForSelector('text=Recent activity', { timeout: 10_000 });
  // The activity panel has its own fetch; rows land a moment after its header.
  await page.waitForSelector('a[href*="explorer.solana.com/tx/"]', { timeout: 20_000 });
  const explorerLinks = await page.locator('a[href*="explorer.solana.com/tx/"]').count();
  if (explorerLinks < 2) fail(`expected ≥2 explorer-linked deposits, saw ${explorerLinks}`);
  ok(`${explorerLinks} on-chain deposit links`);

  const outLinks = await page.locator('main a[href="/solana"]').count();
  if (outLinks > 0) fail('pool tab still links out to /solana');
  ok('no hop to a standalone page');

  const redirect = await page.goto(`${BASE}/en/solana`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (!redirect || !/dashboard/.test(page.url()) || !/chain=solana/.test(page.url())) fail(`/en/solana did not redirect to the pool chain: ${page.url()}`);
  ok('/solana redirects to the dashboard pool chain');

  if (SHOT) {
    await page.screenshot({ path: SHOT, fullPage: true });
    ok(`screenshot → ${SHOT}`);
  }

  // ── API surface via browser context ──
  const status = await (await page.request.get(`${BASE}/api/solana-pool/status`)).json();
  if (!status.enabled || typeof status.vaultTokens !== 'number' || !status.tokenMint) {
    fail(`status JSON incomplete: ${JSON.stringify(status).slice(0, 120)}`);
  }
  ok('status API complete');

  const badBal = await page.request.get(`${BASE}/api/solana-pool/balance?wallet=nope`);
  if (badBal.status() !== 400) fail(`balance should 400 on junk wallet, got ${badBal.status()}`);
  ok('balance API validates wallets');

  const faucetMainGuard = await (
    await page.request.post(`${BASE}/api/solana-pool/faucet`, { data: { wallet: 'x' } })
  ).json();
  if (!('error' in faucetMainGuard)) fail('faucet accepted junk wallet');
  ok('faucet API validates input');

  console.log('\nPLAYWRIGHT E2E: PASS');
} finally {
  await browser.close();
}
