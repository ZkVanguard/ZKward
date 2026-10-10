/**
 * Does the hedge policy circuit refuse what it must refuse?
 *
 *   node test.mjs        (after `node build.mjs`)
 *
 * The checks that matter are the negative ones. An honest proof verifying
 * says little. A proof system is only worth anything if a prover that
 * cheats cannot get a proof accepted, so the last group forges a witness by
 * hand (skipping the witness generator, which is the prover's own check)
 * and shows the verifier still says no.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { poseidon9 } from 'poseidon-lite/poseidon9';

const here = dirname(fileURLToPath(import.meta.url));
const b = (name) => join(here, 'build', name);
const WASM = b('hedge_policy_js/hedge_policy.wasm');
const ZKEY = b('hedge_policy_dev.zkey');
const vkey = JSON.parse(readFileSync(b('verification_key_dev.json'), 'utf8'));
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

/** A hedge inside the rules: 0.5 BTC long at $82,000, 3x, $41,000 notional. */
const HEDGE = {
  assetCode: 1n, sideCode: 0n, sizeMicro: 500_000n, leverageX: 3n,
  entryPriceCents: 8_200_000n, notionalCents: 4_100_000n,
  portfolioId: 2n, timestampMs: 1_791_500_000_000n, salt: 123456789012345678901234567890n,
};
const CAPS = { leverageCap: 4n, notionalCapCents: 100_000_000n };

const commit = (h) => poseidon9([h.assetCode, h.sideCode, h.sizeMicro, h.leverageX, h.entryPriceCents, h.notionalCents, h.portfolioId, h.timestampMs, h.salt]);
const inputFor = (h, caps = CAPS, commitment = commit(h)) =>
  Object.fromEntries(Object.entries({ commitment, ...caps, ...h }).map(([k, v]) => [k, v.toString()]));
const prove = (h, caps, commitment) => snarkjs.groth16.fullProve(inputFor(h, caps, commitment), WASM, ZKEY, quiet);
const verify = (publicSignals, proof) => snarkjs.groth16.verify(vkey, publicSignals, proof, quiet);
const refuses = async (h, caps, commitment) => prove(h, caps, commitment).then(() => false, () => true);

// ── 1. An honest hedge ───────────────────────────────────────────────
const t0 = Date.now();
const honest = await prove(HEDGE);
const proveMs = Date.now() - t0;
check('an honest hedge proves and verifies', await verify(honest.publicSignals, honest.proof), `proved in ${proveMs} ms`);
check('the public signals are the commitment and the two caps, in that order',
  honest.publicSignals.join(',') === [commit(HEDGE), CAPS.leverageCap, CAPS.notionalCapCents].join(','));
check('the TypeScript commitment equals the circuit\'s (the proof would not exist otherwise)', honest.publicSignals[0] === commit(HEDGE).toString());

// ── 2. Each rule, broken: the prover cannot produce a witness ────────
for (const [name, h, caps] of [
  ['leverage above the cap (5 against 4)', { ...HEDGE, leverageX: 5n }],
  ['leverage 1000 against cap 4', { ...HEDGE, leverageX: 1000n }],
  ['leverage 0', { ...HEDGE, leverageX: 0n }],
  ['an asset off the allow-list (code 5)', { ...HEDGE, assetCode: 5n }],
  ['asset code 0', { ...HEDGE, assetCode: 0n }],
  ['a side that is neither long nor short', { ...HEDGE, sideCode: 2n }],
  ['notional above the cap', { ...HEDGE, notionalCents: 100_000_001n, sizeMicro: 1n }],
  ['notional understated against size x price', { ...HEDGE, notionalCents: 4_099_999n }],
  ['a size too large for its range', { ...HEDGE, sizeMicro: 1n << 64n, notionalCents: CAPS.notionalCapCents }],
]) check(`refused: ${name}`, await refuses(h, caps));
check('refused: a commitment that is not this hedge\'s', await refuses(HEDGE, CAPS, commit({ ...HEDGE, leverageX: 2n })));
check('refused: a commitment to an illegal hedge, proven from a legal witness', await refuses(HEDGE, CAPS, commit({ ...HEDGE, leverageX: 1000n })));

// ── 3. A valid proof is valid for its own statement only ─────────────
const [c, lev, cap] = honest.publicSignals;
check('the same proof fails for another commitment', !(await verify([commit({ ...HEDGE, salt: 1n }).toString(), lev, cap], honest.proof)));
check('the same proof fails for a lower leverage cap', !(await verify([c, '2', cap], honest.proof)));
check('the same proof fails for a lower notional cap', !(await verify([c, lev, '1'], honest.proof)));
const tampered = JSON.parse(JSON.stringify(honest.proof));
tampered.pi_a[0] = (BigInt(tampered.pi_a[0]) + 1n).toString();
check('a tampered proof fails', !(await verify(honest.publicSignals, tampered).catch(() => false)));

// ── 4. A prover that cheats: forge the witness by hand ───────────────
// Compute a valid witness, then overwrite wires directly in the witness
// file. Nothing in the proving step checks the constraints, so a proof
// comes out; the question is whether the verifier accepts it.
const wtnsPath = b('honest.wtns');
await snarkjs.wtns.calculate(inputFor(HEDGE), WASM, wtnsPath);
const sym = Object.fromEntries(readFileSync(b('hedge_policy.sym'), 'utf8').trim().split('\n').map((l) => { const [, wire, , name] = l.split(','); return [name, Number(wire)]; }));

function forge(edits, outName) {
  const buf = Buffer.from(readFileSync(wtnsPath));
  // Layout: "wtns", version u32, sections u32, then (id u32, size u64, data).
  let off = 12, n8 = 32, values = -1;
  for (let s = 0; s < buf.readUInt32LE(8); s++) {
    const id = buf.readUInt32LE(off); const size = Number(buf.readBigUInt64LE(off + 4)); const data = off + 12;
    if (id === 1) n8 = buf.readUInt32LE(data);
    if (id === 2) values = data;
    off = data + size;
  }
  for (const [signal, value] of Object.entries(edits)) {
    const wire = sym[`main.${signal}`];
    if (!(wire > 0)) throw new Error(`no wire for ${signal}`);
    let v = BigInt(value);
    for (let i = 0; i < n8; i++) { buf[values + wire * n8 + i] = Number(v & 0xffn); v >>= 8n; }
  }
  writeFileSync(b(outName), buf);
  return b(outName);
}

for (const [name, edits, publicSignals] of [
  ['leverage wire set to 1000, statement unchanged', { leverageX: 1000n }, honest.publicSignals],
  ['leverage wire set to 1000 and the commitment swapped to match it',
    { leverageX: 1000n, commitment: commit({ ...HEDGE, leverageX: 1000n }) },
    [commit({ ...HEDGE, leverageX: 1000n }).toString(), lev, cap]],
  ['notional cap wire raised without changing the public cap', { notionalCents: 500_000_000n }, honest.publicSignals],
]) {
  const forged = forge(edits, 'forged.wtns');
  const made = await snarkjs.groth16.prove(ZKEY, forged, quiet).then((r) => r, () => null);
  const accepted = made ? await verify(publicSignals, made.proof).catch(() => false) : false;
  check(`forged witness (${name}): the verifier refuses`, !accepted, made ? 'a proof was produced; verification failed' : 'no proof could be produced');
}

// The honest proof, kept for the Move test generator (export-move-test.ts).
writeFileSync(b('sample_proof.json'), JSON.stringify({ proof: honest.proof, publicSignals: honest.publicSignals, caps: { leverageCap: CAPS.leverageCap.toString(), notionalCapCents: CAPS.notionalCapCents.toString() } }, null, 2));

console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
