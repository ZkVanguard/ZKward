/**
 * Compile the hedge policy circuit and run a DEVELOPMENT setup.
 *
 *   node build.mjs
 *
 * Needs `circom` on PATH and `npm install` run in this folder. Writes to
 * ./build (not committed):
 *   hedge_policy.r1cs, hedge_policy_js/hedge_policy.wasm   the circuit
 *   hedge_policy_dev.zkey                                   proving key
 *   verification_key_dev.json                               verifying key
 *
 * THE KEYS THIS PRODUCES ARE NOT FOR MAINNET. One machine ran the whole
 * setup, so whoever holds this machine's randomness could forge proofs.
 * Production keys come from a ceremony with independent contributors.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'build');
mkdirSync(out, { recursive: true });
const p = (name) => join(out, name);
// 2^12 constraints is several times this circuit's size.
const POWER = 12;

console.log('1/4 compiling the circuit');
execFileSync('circom', ['hedge_policy.circom', '--r1cs', '--wasm', '--sym', '-o', 'build', '-l', 'node_modules'], { cwd: here, stdio: 'inherit' });

if (!existsSync(p('pot_final.ptau'))) {
  console.log('2/4 powers of tau (development, single contributor)');
  const curve = await snarkjs.curves.getCurveFromName('bn128');
  await snarkjs.powersOfTau.newAccumulator(curve, POWER, p('pot_0.ptau'));
  await snarkjs.powersOfTau.contribute(p('pot_0.ptau'), p('pot_1.ptau'), 'dev', randomBytes(32).toString('hex'));
  await snarkjs.powersOfTau.preparePhase2(p('pot_1.ptau'), p('pot_final.ptau'));
} else {
  console.log('2/4 powers of tau: reusing build/pot_final.ptau');
}

console.log('3/4 circuit keys (development, single contributor)');
await snarkjs.zKey.newZKey(p('hedge_policy.r1cs'), p('pot_final.ptau'), p('hedge_policy_0.zkey'));
await snarkjs.zKey.contribute(p('hedge_policy_0.zkey'), p('hedge_policy_dev.zkey'), 'dev', randomBytes(32).toString('hex'));

console.log('4/4 verifying key');
const vkey = await snarkjs.zKey.exportVerificationKey(p('hedge_policy_dev.zkey'));
writeFileSync(p('verification_key_dev.json'), JSON.stringify(vkey, null, 2));

const info = await snarkjs.r1cs.info(p('hedge_policy.r1cs'));
console.log(`done: ${info.nConstraints} constraints, ${info.nPubInputs} public inputs, ${info.nPrvInputs} private inputs`);
writeFileSync(p('BUILD_INFO.json'), JSON.stringify({ constraints: info.nConstraints, publicInputs: info.nPubInputs, development: true, builtAt: new Date().toISOString(), source: readFileSync(join(here, 'hedge_policy.circom'), 'utf8').length }, null, 2));
process.exit(0);
