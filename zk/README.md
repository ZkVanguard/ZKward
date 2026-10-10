# Proof system

A transparent ZK-STARK (hash-based, no trusted setup). It proves that up to
seven private integers lie within public bounds, optionally with the relation
`1000 * v1 = v4 * v5 + v6`. The hedge policy is one such statement: leverage
and notional within the vault's caps, and the notional covering size times
price.

Status: verified off chain only, not wired into hedge execution, and not
reviewed outside the project. The public position is the "Proofs" section of
`content/whitepaper.md`.

```
zkp/core/stark_core.py     field, extension field, NTT, Merkle trees, transcript, FRI
zkp/core/bounds_stark.py   the proof: prover, verifier, audit opening
zkp/core/hedge_stark.py    the hedge policy statement
zkp/api/server.py          proof server (FastAPI)
zk/prover/ProofGenerator.ts   client of the server; verifies what it receives
zk/verifier/boundsStark.ts    second implementation of the verifier
```

## Run

```bash
python -m pip install -r zkp/requirements.txt
python zkp/api/server.py        # port 8000; proves and verifies one statement before serving
```

## Test

```bash
python -m pytest zkp/tests                                              # prover, forgeries, server
bun jest test/integration/zk-hedge-stark-cross-check.test.ts            # the two verifiers agree
ZK_API_URL=http://127.0.0.1:8000 bun jest test/integration/zk-hedge-policy.test.ts   # through the server
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
proven.verified;                                                  // the local verifier's verdict
verifyHedgePolicyProof(proven.proof, caps, proven.commitment);    // anyone can re-check, with caps they choose
```

The verifier takes the statement from the caller, never from the proof. The
proof's `commitment` commits to the private values; the `opening` returned
next to it is the prover's secret and lets an auditor read them back.
