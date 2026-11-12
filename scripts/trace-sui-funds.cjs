/* eslint-disable */
const { SuiClient } = require('@mysten/sui/client');
const { decodeSuiPrivateKey } = require('@mysten/sui/cryptography');
const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');
require('dotenv').config({ path: '.env.production' });

// No public SUI provider serves JSON-RPC any more; the site's proxy answers it from gRPC.
const c = new SuiClient({ url: (process.env.SUI_JSONRPC_URL || 'https://www.zkward.com/api/rpc/sui').trim() });
const POOL = '0xe814e0948e29d9c10b73a0e6fb23c9997ccc373bed223657ab65ff544742fb3a';

const norm = (v) => (v || '').toString().trim().replace(/[\r\n"']/g, '');
let ADMIN = norm(process.env.SUI_ADMIN_ADDRESS || process.env.NEXT_PUBLIC_SUI_ADMIN_ADDRESS);
if (!ADMIN) {
  const k = norm(process.env.SUI_POOL_ADMIN_KEY);
  if (k) {
    const { secretKey } = decodeSuiPrivateKey(k);
    const kp = Ed25519Keypair.fromSecretKey(secretKey);
    ADMIN = kp.toSuiAddress();
  }
}

const USDC_TYPE = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

(async () => {
  console.log('ADMIN:', ADMIN || '(none)');

  // Admin balances
  if (ADMIN) {
    const bals = await c.getAllBalances({ owner: ADMIN });
    console.log('\n=== ADMIN BALANCES ===');
    for (const b of bals) {
      console.log(`  ${b.coinType}  =>  ${b.totalBalance}  (n=${b.coinObjectCount})`);
    }
  }

  // Pool object & USDC balance
  const obj = await c.getObject({ id: POOL, options: { showContent: true } });
  const f = obj.data.content.fields;
  console.log('\n=== POOL ===');
  console.log('  USDC balance (6dp):', f.balance, '=> $' + (Number(f.balance) / 1e6).toFixed(2));
  console.log('  total_shares:', f.total_shares);
  const hedges = f.hedge_state?.fields?.active_hedges || [];
  console.log('  active_hedges:', hedges.length);
  let totalCollat = 0n;
  for (const h of hedges) {
    const hf = h.fields;
    totalCollat += BigInt(hf.collateral_usdc);
    console.log(`    pair=${hf.pair_index} long=${hf.is_long} collat=${hf.collateral_usdc} (${(Number(hf.collateral_usdc)/1e6).toFixed(4)} USDC) lev=${hf.leverage} opened=${new Date(parseInt(hf.open_time)).toISOString()}`);
  }
  console.log('  hedged collateral total:', totalCollat.toString(), `($${(Number(totalCollat)/1e6).toFixed(2)})`);
  console.log('  total_hedged_value (state):', f.hedge_state?.fields?.total_hedged_value);

  // Recent txs touching pool
  console.log('\n=== RECENT POOL TXs (30) ===');
  const txs = await c.queryTransactionBlocks({
    filter: { ChangedObject: POOL },
    options: { showEffects: true, showInput: true, showBalanceChanges: true },
    limit: 30,
    order: 'descending',
  });
  for (const t of txs.data) {
    let mc = '';
    const tx = t.transaction?.data?.transaction;
    if (tx?.transactions) {
      const calls = tx.transactions.filter(i => i.MoveCall).map(i => `${i.MoveCall.module}::${i.MoveCall.function}`);
      mc = calls.join(',');
    }
    const ts = new Date(parseInt(t.timestampMs || '0')).toISOString();
    const status = t.effects?.status?.status;
    // Find USDC balance change for pool
    const bcs = t.balanceChanges || [];
    const poolUsdc = bcs.find(b => {
      const owner = b.owner?.AddressOwner || b.owner?.ObjectOwner || '';
      return owner.toLowerCase() === POOL.toLowerCase() && b.coinType.includes('::usdc::USDC');
    });
    const adminUsdc = bcs.find(b => {
      const owner = b.owner?.AddressOwner || '';
      return owner.toLowerCase() === ADMIN.toLowerCase() && b.coinType.includes('::usdc::USDC');
    });
    console.log(`${ts}  ${t.digest}  ${status}  [${mc}]`);
    if (poolUsdc) console.log(`    pool USDC Δ: ${poolUsdc.amount}`);
    if (adminUsdc) console.log(`    admin USDC Δ: ${adminUsdc.amount}`);
  }

  // Admin recent activity
  if (ADMIN) {
    console.log('\n=== ADMIN RECENT TX (last 30 from-admin) ===');
    const at = await c.queryTransactionBlocks({
      filter: { FromAddress: ADMIN },
      options: { showEffects: true, showInput: true, showBalanceChanges: true },
      limit: 30,
      order: 'descending',
    });
    for (const t of at.data) {
      const tx = t.transaction?.data?.transaction;
      let mc = '';
      if (tx?.transactions) {
        const calls = tx.transactions.filter(i => i.MoveCall).map(i => `${i.MoveCall.module}::${i.MoveCall.function}`);
        mc = calls.join(',');
      }
      const ts = new Date(parseInt(t.timestampMs || '0')).toISOString();
      const status = t.effects?.status?.status;
      console.log(`${ts}  ${t.digest}  ${status}  [${mc}]`);
      const bcs = t.balanceChanges || [];
      for (const b of bcs) {
        const owner = b.owner?.AddressOwner || '';
        if (owner.toLowerCase() === ADMIN.toLowerCase() && Math.abs(Number(b.amount)) > 1000) {
          const sym = b.coinType.split('::').pop();
          console.log(`    Δ ${sym}: ${b.amount}`);
        }
      }
    }
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
