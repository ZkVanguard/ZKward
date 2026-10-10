# Proof system

A transparent ZK-STARK (hash-based, no trusted setup). It proves that up to
seven private integers lie within public bounds, optionally with the relation
`1000 * v1 = v4 * v5 + v6`. The hedge policy is one such statement: leverage
and notional within the vault's caps, and the notional covering size times
price.

Status: proved and verified inside the application, off chain; not wired into
hedge execution; not reviewed outside the project. The public position is the
"Proofs" section of `content/whitepaper.md`.

```
zk/prover/boundsProver.ts     the prover
zk/prover/ProofGenerator.ts   proves, then verifies what it made
zk/verifier/boundsStark.ts    the verifier; the prover takes its field, hash and transcript from here

zkp/core/stark_core.py        reference implementation in Python: field, Merkle trees, transcript, FRI
zkp/core/bounds_stark.py      reference prover and verifier, audit opening, the hooks the forgery tests use
zkp/core/hedge_stark.py       the hedge policy statement
```

The two implementations must agree: each verifier accepts the other prover's
proofs, and both verifiers give the same verdict on a corpus of honest and
forged proofs.

## Test

```bash
python -m pip install -r zkp/requirements.txt
python -m pytest zkp/tests                                        # reference prover, forgeries, measured error
bun jest test/integration/zk-hedge-stark-cross-check.test.ts      # both verifiers on one corpus
bun jest test/integration/zk-hedge-policy.test.ts                 # the in-process prover against both verifiers
```

## Use

```ts
import { proveHedgePolicy } from '@/zk/prover/ProofGenerator';
import { verifyHedgePolicyProof } from '@/zk/verifier/boundsStark';

const caps = { leverage_cap: 4, notional_cap_cents: 100_000_000 };
const proven = await proveHedgePolicy(
  { asset: 'BTC', side: 'LONG', leverageX: 3, notionalValueUsdcCents: 4_100_000, sizeMilli: 500, entryPriceCents: 8_200_000 },
  caps,
);
proven.verified;                                                  // the verifier's verdict
verifyHedgePolicyProof(proven.proof, caps, proven.commitment);    // anyone can re-check, with caps they choose
```

The verifier takes the statement from the caller, never from the proof. The
proof's `commitment` commits to the private values; the `opening` returned
next to it is the prover's secret and lets an auditor read them back.
