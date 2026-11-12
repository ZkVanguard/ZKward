/* eslint-disable */
/**
 * Top up admin wallet with SUI for gas.
 * Reads SUI_POOL_ADMIN_KEY (admin's own key) — admin sends to itself? No.
 * This script transfers from a FUNDER key to the admin address.
 *
 * Usage:  node scripts/topup-sui-admin.cjs <amount-in-SUI>
 *   Funder key:   SUI_FUNDER_KEY  (env)
 *   Admin addr:   derived from SUI_POOL_ADMIN_KEY  OR  SUI_ADMIN_ADDRESS
 *
 * If SUI_FUNDER_KEY is not set, the script prints the admin address and exits
 * so you can send SUI manually from a wallet (e.g. Suiet/Slush).
 */
const { SuiClient } = require('@mysten/sui/client');
const { Transaction } = require('@mysten/sui/transactions');
const { decodeSuiPrivateKey } = require('@mysten/sui/cryptography');
const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');
require('dotenv').config({ path: '.env.production' });

const norm = (v) => (v || '').toString().trim().replace(/[\r\n"']/g, '');

(async () => {
  const amountSui = parseFloat(process.argv[2] || '1');
  if (!amountSui || amountSui <= 0 || amountSui > 10) {
    console.error('Usage: node scripts/topup-sui-admin.cjs <amount-SUI 0..10>');
    process.exit(1);
  }

  const adminKey = norm(process.env.SUI_POOL_ADMIN_KEY);
  let adminAddr = norm(process.env.SUI_ADMIN_ADDRESS);
  if (adminKey && !adminAddr) {
    const { secretKey } = decodeSuiPrivateKey(adminKey);
    adminAddr = Ed25519Keypair.fromSecretKey(secretKey).toSuiAddress();
  }
  if (!adminAddr) {
    console.error('Admin address could not be derived');
    process.exit(1);
  }

  // No public SUI provider serves JSON-RPC any more; the site's proxy answers it from gRPC.
  const c = new SuiClient({ url: (process.env.SUI_JSONRPC_URL || 'https://www.zkward.com/api/rpc/sui').trim() });
  const beforeBal = await c.getBalance({ owner: adminAddr });
  console.log(`Admin: ${adminAddr}`);
  console.log(`Current SUI balance: ${(Number(beforeBal.totalBalance) / 1e9).toFixed(4)} SUI`);

  const funderKey = norm(process.env.SUI_FUNDER_KEY);
  if (!funderKey) {
    console.log('\nNo SUI_FUNDER_KEY in env. Send SUI manually to the admin address above.');
    console.log(`Recommended top-up: ${amountSui} SUI`);
    process.exit(0);
  }

  const { secretKey: fk } = decodeSuiPrivateKey(funderKey);
  const funder = Ed25519Keypair.fromSecretKey(fk);
  const funderAddr = funder.toSuiAddress();
  console.log(`Funder: ${funderAddr}`);
  const fb = await c.getBalance({ owner: funderAddr });
  console.log(`Funder SUI balance: ${(Number(fb.totalBalance) / 1e9).toFixed(4)} SUI`);

  const amountMist = BigInt(Math.floor(amountSui * 1e9));
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [amountMist]);
  tx.transferObjects([coin], adminAddr);

  const result = await c.signAndExecuteTransaction({
    signer: funder,
    transaction: tx,
    options: { showEffects: true },
  });
  console.log('Tx:', result.digest, 'status:', result.effects?.status?.status);
  if (result.effects?.status?.status !== 'success') {
    console.error('Transfer failed:', result.effects?.status?.error);
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 2000));
  const afterBal = await c.getBalance({ owner: adminAddr });
  console.log(`New admin balance: ${(Number(afterBal.totalBalance) / 1e9).toFixed(4)} SUI`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
