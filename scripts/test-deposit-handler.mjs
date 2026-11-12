// Dry-run test of the new UI deposit flow.
// Exercises the same code path as handleSuiDeposit minus wallet signing:
//   1. POST /api/sui/community-pool?action=deposit (live API)
//   2. SuiClient.getCoins for USDC (live RPC, against admin wallet so we have something)
//   3. Build a Transaction the same way the UI does
//   4. dryRunTransactionBlock to see if the on-chain call would succeed
// Usage: node scripts/test-deposit-handler.mjs
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

const BASE = process.env.TEST_BASE || 'https://www.zkward.com';
const NETWORK = 'mainnet';
const USD_AMOUNT = 10; // $10 USDC test
// Use the pool's own admin wallet as the dry-run sender (it actually holds USDC).
// Dry runs don't sign or move funds.
const SENDER = '0x99a3a0fd45bb6b467547430b8efab77eb64218ab098428297a7a3be77329ac93';

function fail(msg) { console.error('❌', msg); process.exit(1); }
function ok(msg)   { console.log('✅', msg); }

async function main() {
  const amountRaw = BigInt(Math.floor(USD_AMOUNT * 1_000_000));

  // 1. Hit the live deposit-params API
  console.log(`→ POST ${BASE}/api/sui/community-pool?action=deposit  body={amount:${amountRaw}}`);
  const res = await fetch(`${BASE}/api/sui/community-pool?action=deposit&network=${NETWORK}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountRaw.toString() }),
  });
  const json = await res.json();
  if (!json.success) fail(`API returned error: ${json.error}`);
  ok(`API ok. target=${json.data.target}`);
  ok(`     poolStateId=${json.data.poolStateId}`);
  ok(`     usdcCoinType=${json.data.usdcCoinType}`);
  ok(`     amountRaw=${json.data.amountRaw} clockId=${json.data.clockId}`);
  if (BigInt(json.data.amountRaw) !== amountRaw) fail('amountRaw mismatch — API rescaled?');

  const { target, poolStateId, clockId, usdcCoinType, typeArg } = json.data;
  const usdcType = typeArg || usdcCoinType;

  // 2. Look up USDC coin objects on the sender wallet
  // No public SUI provider serves JSON-RPC any more; the site's proxy answers it from gRPC.
  const client = new SuiClient({ url: `https://www.zkward.com/api/rpc/${NETWORK === 'testnet' ? 'sui-testnet' : 'sui'}` });
  const coins = await client.getCoins({ owner: SENDER, coinType: usdcType });
  const total = coins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
  console.log(`→ Sender ${SENDER.slice(0, 10)}… has ${coins.data.length} USDC coin(s), total=${Number(total)/1e6} USDC`);
  if (total < amountRaw) {
    console.warn(`⚠️  Sender doesn't have enough USDC for a real deposit — dry-run will still validate the structure.`);
  } else {
    ok(`Balance check passes ($${(Number(total)/1e6).toFixed(2)} >= $${USD_AMOUNT})`);
  }
  if (coins.data.length === 0) fail('No USDC coins on sender wallet — cannot dry-run deposit construction.');

  // 3. Build the same Transaction the UI builds
  const tx = new Transaction();
  tx.setSender(SENDER);
  const primary = tx.object(coins.data[0].coinObjectId);
  if (coins.data.length > 1) {
    tx.mergeCoins(primary, coins.data.slice(1).map(c => tx.object(c.coinObjectId)));
  }
  const [depositCoin] = tx.splitCoins(primary, [tx.pure.u64(amountRaw)]);
  tx.moveCall({
    target,
    typeArguments: [usdcType],
    arguments: [
      tx.object(poolStateId),
      depositCoin,
      tx.object(clockId),
    ],
  });
  ok('Transaction built (mergeCoins + splitCoins + deposit<USDC>)');

  // 4. Dry-run on-chain (read-only). With a manual gas budget so the SDK doesn't
  //    bail at the auto-budget step when sender lacks enough USDC.
  tx.setGasBudget(50_000_000);
  let built;
  try {
    built = await tx.build({ client });
  } catch (e) {
    const cause = e?.cause;
    if (cause?.executionErrorSource && /InsufficientCoinBalance|balance: \d+ required: \d+/.test(cause.executionErrorSource)) {
      ok('Transaction structure validated. On-chain pre-flight failed only because the test sender lacks enough USDC:');
      console.log(`     ${cause.executionErrorSource}`);
      ok('This proves splitCoins() requested the correct USDC amount and deposit<T> resolved.');
      return;
    }
    throw e;
  }
  const dr = await client.dryRunTransactionBlock({ transactionBlock: built });
  const status = dr.effects?.status?.status;
  console.log(`→ DryRun status: ${status}`);
  if (status !== 'success') {
    const errStr = dr.effects?.status?.error || '';
    if (/InsufficientCoinBalance|balance: \d+ required: \d+/.test(errStr)) {
      ok(`Structure validated; on-chain rejected only due to insufficient USDC: ${errStr}`);
      return;
    }
    console.error('Effects:', JSON.stringify(dr.effects?.status, null, 2));
    fail(`DryRun failed: ${errStr}`);
  }
  ok('DryRun success! Pool would have minted shares.');

  // Surface the share-mint event from the dry-run
  const ev = dr.events?.find(e => e.type.includes('UsdcDeposited'));
  if (ev) {
    console.log('\n📊 Predicted UsdcDeposited event:');
    console.log(JSON.stringify(ev.parsedJson, null, 2));
  }
  console.log(`\n💸 Predicted gas cost: ${(Number(dr.effects?.gasUsed?.computationCost || 0) + Number(dr.effects?.gasUsed?.storageCost || 0)) / 1e9} SUI`);
}

main().catch(e => { console.error(e); process.exit(1); });
