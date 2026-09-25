# ZkVanguard Contracts (EVM)

Solidity smart contracts for ZkVanguard on Cronos zkEVM.

## Overview

This repository contains the core smart contracts for ZkVanguard's decentralized risk management platform:

- **RWAManager.sol** - Real-World Asset portfolio management
- **HedgeExecutor.sol** - Automated hedging execution via Moonlander perpetuals  
- **ZKProxyVault.sol** - Privacy-preserving vault with ZK proof verification
- **PaymentRouter.sol** - EIP-3009/x402 gasless transaction handling
- **CommunityPoolV2.sol** - Shared liquidity pool for collective hedging

## Deployments

### Cronos zkEVM Testnet (Chain ID: 240)
- CommunityPoolV2: `0xYourAddress`
- HedgeExecutor: `0xYourAddress`
- ZKProxyVault: `0xYourAddress`

## Development

### Prerequisites
- Node.js 18+
- Hardhat

### Install
```bash
npm install
```

### Compile
```bash
npx hardhat compile
```

### Test
```bash
npx hardhat test
```

### Deploy
```bash
npx hardhat run scripts/deploy.js --network cronos-testnet
```

## Security

All contracts undergo security review before mainnet deployment. Report vulnerabilities to security@zkward.io.

## License

Apache License 2.0 - see [LICENSE](LICENSE)

## Related Repositories

- [ZkVanguard](https://github.com/ZkVanguard/ZkVanguard) - Main application
- [contracts-sui](https://github.com/ZkVanguard/contracts-sui) - Move contracts for SUI
- [ai-agents](https://github.com/ZkVanguard/ai-agents) - AI agent swarm
- [zkp-engine](https://github.com/ZkVanguard/zkp-engine) - ZK-STARK proof engine
