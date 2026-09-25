# Composable Substreams module — CommunityPool Vault Events

Reusable Substreams module for AI-managed ERC-4626-shaped vaults. Emits a normalized `VaultEvents` stream any downstream sink (subgraph, dashboard SSE, alert pipeline, ML feature store) can consume.

Directly targets the Graph prize wording:

> **"Contributing a new composable Substreams module for an emerging standard, such as ERC-4626 tokenized-vault flows, also counts."**

## What it is

- **Input:** `sf.ethereum.type.v2.Block` (any Ethereum-compatible chain the Graph Substreams provider indexes — 45+ chains and counting)
- **Output:** `zkward.vault.v1.VaultEvents` — a proto union of `Deposit`, `Withdraw`, `FeesCollected`, `Rebalance`, `HedgeOpened`, `HedgeClosed`, `NavSnapshot` (defined in [`proto/vault.proto`](./proto/vault.proto))
- **Params:** one string — the contract address to filter on. Swap it and any AI vault emitting the same event surface plugs in with zero code change.

## What ships in v0.1 (this module)

Rust handler `map_vault_events` decodes and emits:

| Event | Signature | Emitted as |
|---|---|---|
| `Deposited` | `Deposited(address indexed member, uint256 amount, uint256 shares)` | `Deposit { member, amountUsd, sharesMinted }` |
| `Withdrawn` | `Withdrawn(address indexed member, uint256 shares, uint256 amount)` | `Withdraw { member, sharesBurned, amountUsd }` |
| `FeesCollected` | `FeesCollected(uint256, uint256, uint256)` | `FeesCollected { managementFee, performanceFee }` |
| `MemberJoined` | `MemberJoined(address indexed member, uint256)` | `Deposit { member, 0, 0 }` (proto union extension in v0.2) |

**Deferred to v0.2** — `Rebalanced` and `PoolHedgeOpened/Closed` have dynamic-length calldata (arrays + strings); need ABI-Encode-aware decoding helpers. The module's proto union already declares them so downstream sinks can consume them ahead of time.

## Files

```
substreams/community-pool/
├── Cargo.toml         # Rust manifest — substreams + substreams-ethereum + prost
├── build.rs           # prost-build → src/pb/vault.rs at compile time
├── proto/
│   └── vault.proto    # VaultEvents union definition
├── src/
│   ├── lib.rs         # map_vault_events handler + decoders + host-side tests
│   └── pb/
│       └── mod.rs     # includes the generated proto Rust code
├── substreams.yaml    # module manifest (inputs, outputs, network params)
└── README.md          # this file
```

## Build

```bash
# One-time: add the wasm target if you don't have it.
rustup target add wasm32-unknown-unknown

# Compile → target/wasm32-unknown-unknown/release/substreams.wasm
cargo build --target wasm32-unknown-unknown --release

# Pack for the Substreams registry / consumers
substreams pack     # requires the substreams CLI (macOS: `brew install streamingfast/tap/substreams`;
                    #  Windows: `go install github.com/streamingfast/substreams/cmd/substreams@latest` after cloning)
```

The Cargo release profile is tuned for tiny wasm output (`lto = true`, `opt-level = "s"`, strip debug info).

## Prebuilt package

A packed `.spkg` is committed at [`dist/zkward-community-pool-v0.1.0.spkg`](./dist/) (372 KB). Consumers can use it directly without the Rust toolchain:

```bash
# Inspect the package
substreams info dist/zkward-community-pool-v0.1.0.spkg

# Stream module outputs against a Substreams endpoint (requires a subscription
# via https://substreams.dev — free for hackathon-scale use)
substreams gui dist/zkward-community-pool-v0.1.0.spkg map_vault_events \
  --start-block 5700000 --stop-block +100
```

`substreams info` on the packed file reports the module accepts `params: string` (contract address) and outputs `zkward.vault.v1.VaultEvents`, matching the yaml.

## Test

Host-side unit tests cover the decoding primitives — hex → decimal, address-from-topic, param validation, ABI word extraction. No wasm/substreams runtime needed for these:

```bash
cargo test
```

Full end-to-end test (fetches a real Sepolia block, runs the wasm handler, prints the output) needs the substreams CLI:

```bash
substreams gui substreams.yaml map_vault_events --start-block 5700000 --stop-block +100
```

## Consumer pattern — subgraph replacement for pool-nav-monitor

Instead of the QStash-triggered polling cron in the ZKward repo (`pool-nav-monitor` every 15 min) writing to Aiven Postgres, a subgraph in [`../../subgraph/`](../../subgraph/) can ingest this Substreams module as its data source. Result: one contract → one module → one subgraph → every downstream reader gets sub-block latency.

## Standards leverage

The `VaultEvents` proto union is intentionally protocol-agnostic:

- `NavSnapshot { totalNav, totalShares, sharePrice }`
- `Rebalance { previousBps[], newBps[], reasonHash, executor }`
- `HedgeOpened { hedgeId, pairIndex, collateralAmount, leverage, isLong, reasonHash }`
- `HedgeClosed { hedgeId, realizedPnl, reasonHash }`
- `Deposit { member, amountUsd, sharesMinted, sharePrice }`
- `Withdraw { member, sharesBurned, amountUsd, sharePrice }`
- `FeesCollected { managementFee, performanceFee }`

Any AI-managed vault protocol that emits the equivalent events on-chain can plug into this module by swapping the contract address in `substreams.yaml.networks.*.params` — no protobuf change. That's the "one pipeline reused across chains, one query pattern across protocols" test the Graph rubric points at.

## Roadmap

- **v0.1** (this release) — `Deposit` / `Withdraw` / `FeesCollected` decoders + host-side unit tests + build wiring. Rust handler ships alongside the proto schema.
- **v0.2** — `Rebalanced` + `PoolHedgeOpened/Closed` decoders (ABI-encoded arrays + string reason hashes). First-class `MemberJoined` and `NavSnapshot` proto entries.
- **v0.3** — Multi-chain params (index the same schema across Sepolia + Cronos + Hedera-EVM once Substreams indexes the latter).

## License

Apache-2.0.
