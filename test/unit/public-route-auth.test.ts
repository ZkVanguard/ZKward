/**
 * Routes that can trade, sign, or change how the live pool is hedged must
 * check a service credential before they do anything else. A wallet signature
 * is not one: it proves someone controls some wallet, nothing about a right
 * to operate the pool.
 *
 * This reads the route sources, so it fails the moment a handler is added or
 * an auth line is moved, without needing a running server.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

/** Source of one exported handler, from its declaration to the next export (or end of file). */
function handler(src: string, method: string): string | null {
  const start = src.search(new RegExp(`export async function ${method}\\b`));
  if (start === -1) return null;
  const rest = src.slice(start + 1);
  const next = rest.search(/\nexport (async )?function /);
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

const SERVICE_ONLY: Array<{ file: string; methods: string[] }> = [
  { file: 'app/api/agents/hedging/close/route.ts', methods: ['POST'] },
  { file: 'app/api/agents/auto-hedge/route.ts', methods: ['POST', 'DELETE'] },
  { file: 'app/api/agents/monitor/route.ts', methods: ['POST'] },
  { file: 'app/api/community-pool/auto-hedge/route.ts', methods: ['POST'] },
  { file: 'app/api/debug/sui-pool-status/route.ts', methods: ['GET'] },
];

describe('service-only handlers authenticate before any work', () => {
  for (const { file, methods } of SERVICE_ONLY) {
    for (const method of methods) {
      it(`${method} ${file}`, () => {
        const body = handler(read(file), method);
        expect(body).not.toBeNull();
        // a live statement, not a comment
        const line = body!.match(/^[ \t]*const authResult = await verifyCronRequest\(request, '[^']+'\);$/m);
        expect(line).not.toBeNull();
        const auth = body!.indexOf(line![0]);
        // nothing is awaited before it except the rate limiter and loading the auth helper itself
        const before = body!
          .slice(0, auth)
          .split('\n')
          .filter((l) => /\bawait\b/.test(l) && !/Limiter|import\('@\/lib\/qstash'\)|import\('@\/lib\/security\/rate-limiter'\)/.test(l));
        expect(before).toEqual([]);
        // the refusal is returned, not just computed
        expect(body!.slice(auth)).toMatch(/if \(authResult !== true\) return authResult;/);
        for (const work of ['request.json()', 'await import(\'@/lib/db', 'Service.', 'process.env.']) {
          const at = body!.indexOf(work);
          if (at !== -1) expect(at).toBeGreaterThan(auth);
        }
        expect(body).not.toContain('requireAuth(');
      });
    }
  }
});

describe('the venue route only reads', () => {
  const src = read('app/api/agents/hedging/bluefin/route.ts');
  it('exports GET and nothing that can place or close an order', () => {
    expect(handler(src, 'GET')).not.toBeNull();
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(handler(src, m)).toBeNull();
    for (const call of ['openHedge', 'closeHedge', 'createHedge', 'updateHedgeStatus', 'placeOrder']) expect(src).not.toContain(call);
  });
});

describe('browser-callable pool actions cannot move funds', () => {
  it('record-deposit proves the transaction and never plans or executes a swap', () => {
    const src = read('app/api/sui/community-pool/handlers/deposit-actions.ts');
    const body = src.slice(src.indexOf('export async function handleRecordDeposit'));
    expect(body).toContain("provePoolTx(ctx, 'UsdcDeposited')");
    for (const call of ['executeRebalance', 'planRebalanceSwaps', 'executeSwap', 'getBluefinAggregatorService', 'allocations', 'body.amountUsdc']) {
      expect(body).not.toContain(call);
    }
  });

  it('record-withdraw proves the transaction', () => {
    const src = read('app/api/sui/community-pool/handlers/withdraw-actions.ts');
    const body = src.slice(src.indexOf('export async function handleRecordWithdraw'));
    expect(body).toContain("provePoolTx(ctx, 'UsdcWithdrawn')");
    expect(body).not.toContain('body.sharesToBurn');
  });

  it('the withdraw preflight checks on-chain ownership before the liquidity top-up', () => {
    const src = read('app/api/sui/community-pool/handlers/withdraw-actions.ts');
    const owned = src.indexOf('readMemberSharesStrict(network, walletAddress)');
    const topUp = src.indexOf('ensurePoolLiquidityForWithdraw(');
    expect(owned).toBeGreaterThan(-1);
    expect(topUp).toBeGreaterThan(owned);
    // the top-up lives in the inner function, reachable only through the checked wrapper
    const inner = src.indexOf('async function prepareWithdraw(');
    expect(inner).toBeGreaterThan(owned);
    expect(topUp).toBeGreaterThan(inner);
    expect(src).not.toContain('export async function prepareWithdraw');
  });

  it('admin swap actions keep their service credential', () => {
    for (const [file, fn] of [
      ['app/api/sui/community-pool/handlers/deposit-actions.ts', 'handleExecuteDepositSwaps'],
      ['app/api/sui/community-pool/handlers/withdraw-actions.ts', 'handleExecuteWithdrawSwaps'],
    ]) {
      const src = read(file);
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      const auth = body.indexOf('verifyCronRequest(request');
      expect(auth).toBeGreaterThan(-1);
      expect(body.indexOf('getBluefinAggregatorService(')).toBeGreaterThan(auth);
    }
  });
});

describe('proof verification never signs with the operator key', () => {
  const src = read('app/api/zk-proof/verify-hedge-onchain/route.ts');
  it('has no signing path', () => {
    for (const s of ['signAndExecuteTransaction', 'signTransaction', 'SUI_POOL_ADMIN_KEY', 'PRIVATE_KEY', 'Keypair', 'setSender']) expect(src).not.toContain(s);
  });
});

describe('auto-rebalance: a wallet edits only its own portfolio', () => {
  const src = read('app/api/agents/auto-rebalance/route.ts');
  for (const method of ['POST', 'PATCH']) {
    it(`${method} authenticates, then checks the wallet's scope, before any write`, () => {
      const body = handler(src, method)!;
      const auth = body.indexOf('requireAuth(request');
      const scope = body.indexOf('walletScopeError(authResult');
      expect(auth).toBeGreaterThan(-1);
      expect(scope).toBeGreaterThan(auth);
      for (const write of ['saveAutoRebalanceConfig(', 'deleteAutoRebalanceConfig(', 'autoRebalanceService.start(', 'autoRebalanceService.stop(']) {
        const at = body.indexOf(write);
        if (at !== -1) expect(at).toBeGreaterThan(scope);
      }
    });
  }
});
