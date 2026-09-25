const { HardhatUserConfig } = require('hardhat/config');
require('@nomicfoundation/hardhat-toolbox');
require('@nomicfoundation/hardhat-verify');
require('@openzeppelin/hardhat-upgrades');
require('hardhat-gas-reporter');
require('hardhat-contract-sizer');
require('solidity-coverage');
const dotenv = require('dotenv');

dotenv.config({ path: '.env.local' });

const config = {
  'ts-node': {
    project: './tsconfig.hardhat.json'
  },
  solidity: {
    // OZ contracts moved to pragma ^0.8.24 in recent versions — need a
    // matching compiler. Kept the 0.8.22 slot for legacy contracts.
    compilers: [
      {
        version: '0.8.24',
        settings: {
          optimizer: { enabled: true, runs: 1 },
          viaIR: true,
          evmVersion: 'cancun',
        },
      },
      {
        version: '0.8.22',
        settings: {
          optimizer: { enabled: true, runs: 1 },
          viaIR: true,
          evmVersion: 'cancun',
        },
      },
    ],
  },
  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: true,
    },
    'hedera-testnet': {
      chainId: 296,
      url: process.env.HEDERA_TESTNET_RPC || 'https://testnet.hashio.io/api',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 'auto',
      timeout: 120000,
    },
    'hedera-mainnet': {
      chainId: 295,
      url: process.env.HEDERA_MAINNET_RPC || 'https://mainnet.hashio.io/api',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 'auto',
      timeout: 120000,
    },
  },
  etherscan: {
    apiKey: {
      'hedera-testnet': process.env.HASHSCAN_API_KEY || '',
      'hedera-mainnet': process.env.HASHSCAN_API_KEY || '',
    },
    customChains: [
      {
        network: 'hedera-testnet',
        chainId: 296,
        urls: {
          apiURL: 'https://server-verify.hashscan.io/api',
          browserURL: 'https://hashscan.io/testnet/',
        },
      },
      {
        network: 'hedera-mainnet',
        chainId: 295,
        urls: {
          apiURL: 'https://server-verify.hashscan.io/api',
          browserURL: 'https://hashscan.io/mainnet/',
        },
      },
    ],
  },
  sourcify: {
    enabled: true,
    apiUrl: "https://sourcify.dev/server",
    browserUrl: "https://repo.sourcify.dev",
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === 'true',
    currency: 'USD',
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    outputFile: 'gas-report.txt',
    noColors: true,
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
    disambiguatePaths: false,
  },
  paths: {
    sources: './contracts',
    tests: './test/unit/contracts',
    cache: './cache',
    artifacts: './artifacts',
  },
  mocha: {
    timeout: 120000,
  },
  typechain: {
    outDir: 'typechain-types',
    target: 'ethers-v6',
  },
};

module.exports = config;
