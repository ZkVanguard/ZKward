/**
 * Playwright E2E for the Solana pool UI (browser-level, headless chromium).
 *
 * Not a jest test — run directly: `bun test/integration/solana-pool-ui.pw.ts`
 * against a running server (BASE_URL env, default local prod server :3113).
 * Asserts the page renders live pool state end-to-end (status API → DOM),
 * the wallet CTA exists, the on-chain deposit trail is linked, and the API
 * surface validates input. Wallet signing itself can't run headless (no
 * extension) — that path is covered by the scripted user-journey E2E.
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

  // ── /solana page renders live state ──
  const resp = await page.goto(`${BASE}/en/solana`, { waitUntil: 'networkidle', timeout: 60_000 });
  if (!resp || resp.status() >= 400) fail(`/en/solana HTTP ${resp?.status()}`);
  await page.waitForSelector('h1:has-text("Solana Token Pool")', { timeout: 20_000 });
  ok('page title renders');

  await page.waitForSelector('text=/Testnet/i', { timeout: 10_000 });
  ok('TESTNET badge visible');

  // Live pool state populated from the status API (not placeholders)
  await page.waitForSelector('text=Pool state (live from chain)', { timeout: 20_000 });
  const vaultCell = await page
    .locator('div:has(> div:text("Vault balance")) >> div.font-bold')
    .first()
    .textContent({ timeout: 15_000 });
  if (!vaultCell || !/[\d,]{4,}/.test(vaultCell)) fail(`vault balance not populated: "${vaultCell}"`);
  ok(`vault balance populated (${vaultCell.trim()})`);

  await page.waitForSelector('text=Trading sleeve', { timeout: 10_000 });
  await page.waitForSelector('text=Win rate', { timeout: 10_000 });
  ok('sleeve card with win-rate present');

  await page.waitForSelector('button:has-text("Connect Solana wallet")', { timeout: 10_000 });
  ok('wallet connect CTA present');

  const explorerLinks = await page.locator('a[href*="explorer.solana.com/tx/"]').count();
  if (explorerLinks < 2) fail(`expected ≥2 explorer-linked deposits, saw ${explorerLinks}`);
  ok(`${explorerLinks} on-chain deposit links`);

  const ataShown = await page.locator('code').first().textContent();
  if (!ataShown || ataShown.trim().length < 32) fail('vault ATA not shown');
  ok('deposit address rendered');

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
