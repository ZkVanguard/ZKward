/**
 * @fileoverview Configuration management utility
 * @module shared/utils/config
 */

import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { NetworkConfig, ContractAddresses } from '../types/blockchain';

// Load environment variables
dotenv.config();

/**
 * Network configurations
 */
export const networks: Record<string, NetworkConfig> = {
  // ============================================
  // CRONOS CHAINS (EVM-Compatible)
  // ============================================
  'cronos-testnet': {
    chainId: 338,
    name: 'Cronos Testnet',
    rpcUrl: process.env.CRONOS_TESTNET_RPC || 'https://evm-t3.cronos.org/',
    explorerUrl: 'https://explorer.cronos.org/testnet/',
    nativeCurrency: {
      name: 'Test CRO',
      symbol: 'TCRO',
      decimals: 18,
    },
  },
  'cronos-mainnet': {
    chainId: 25,
    name: 'Cronos Mainnet',
    rpcUrl: process.env.CRONOS_MAINNET_RPC || 'https://evm.cronos.org/',
    explorerUrl: 'https://explorer.cronos.org/',
    nativeCurrency: {
      name: 'CRO',
      symbol: 'CRO',
      decimals: 18,
    },
  },
  
  // ============================================
  // SUI CHAINS (Move-based)
  // ============================================
  'sui-testnet': {
    chainId: 0, // SUI uses string-based chain IDs
    name: 'SUI Testnet',
    rpcUrl: process.env.SUI_TESTNET_RPC || 'https://fullnode.testnet.sui.io:443',
    explorerUrl: 'https://suiexplorer.com/?network=testnet',
    nativeCurrency: {
      name: 'SUI',
      symbol: 'SUI',
      decimals: 9,
    },
  },
  'sui-mainnet': {
    chainId: 0, // SUI uses string-based chain IDs
    name: 'SUI Mainnet',
    rpcUrl: process.env.SUI_MAINNET_RPC || 'https://fullnode.mainnet.sui.io:443',
    explorerUrl: 'https://suiexplorer.com',
    nativeCurrency: {
      name: 'SUI',
      symbol: 'SUI',
      decimals: 9,
    },
  },
  'sui-devnet': {
    chainId: 0,
    name: 'SUI Devnet',
    rpcUrl: process.env.SUI_DEVNET_RPC || 'https://fullnode.devnet.sui.io:443',
    explorerUrl: 'https://suiexplorer.com/?network=devnet',
    nativeCurrency: {
      name: 'SUI',
      symbol: 'SUI',
      decimals: 9,
    },
  },
  
  // ============================================
  // OASIS CHAINS (EVM-Compatible ParaTimes)
  // ============================================
  'oasis-sapphire-testnet': {
    chainId: 23295,
    name: 'Oasis Sapphire Testnet',
    rpcUrl: process.env.OASIS_SAPPHIRE_TESTNET_RPC || 'https://testnet.sapphire.oasis.io',
    explorerUrl: 'https://explorer.oasis.io/testnet/sapphire',
    nativeCurrency: {
      name: 'Test ROSE',
      symbol: 'TEST',
      decimals: 18,
    },
  },
  'oasis-sapphire-mainnet': {
    chainId: 23294,
    name: 'Oasis Sapphire',
    rpcUrl: process.env.OASIS_SAPPHIRE_MAINNET_RPC || 'https://sapphire.oasis.io',
    explorerUrl: 'https://explorer.oasis.io/mainnet/sapphire',
    nativeCurrency: {
      name: 'ROSE',
      symbol: 'ROSE',
      decimals: 18,
    },
  },
  'oasis-emerald-testnet': {
    chainId: 42261,
    name: 'Oasis Emerald Testnet',
    rpcUrl: process.env.OASIS_EMERALD_TESTNET_RPC || 'https://testnet.emerald.oasis.io',
    explorerUrl: 'https://explorer.oasis.io/testnet/emerald',
    nativeCurrency: {
      name: 'Test ROSE',
      symbol: 'TEST',
      decimals: 18,
    },
  },
  'oasis-emerald-mainnet': {
    chainId: 42262,
    name: 'Oasis Emerald',
    rpcUrl: process.env.OASIS_EMERALD_MAINNET_RPC || 'https://emerald.oasis.io',
    explorerUrl: 'https://explorer.oasis.io/mainnet/emerald',
    nativeCurrency: {
      name: 'ROSE',
      symbol: 'ROSE',
      decimals: 18,
    },
  },

  // ============================================
  // LOCAL DEVELOPMENT
  // ============================================
  hardhat: {
    chainId: 31337,
    name: 'Hardhat Local',
    rpcUrl: 'http://127.0.0.1:8545',
    explorerUrl: '',
    nativeCurrency: {
      name: 'ETH',
      symbol: 'ETH',
      decimals: 18,
    },
  },
};

/**
 * Get network configuration
 */
export function getNetworkConfig(networkName: string): NetworkConfig {
  const config = networks[networkName];
  if (!config) {
    throw new Error(`Network configuration not found: ${networkName}`);
  }
  return config;
}

/**
 * Get current network from environment
 */
export function getCurrentNetwork(): NetworkConfig {
  const networkName = process.env.NETWORK || 'hardhat';
  return getNetworkConfig(networkName);
}

/**
 * Load contract addresses from deployment file
 */
export function loadContractAddresses(networkName: string): ContractAddresses | null {
  const deploymentFile = path.join(
    process.cwd(),
    'deployments',
    networkName,
    'addresses.json'
  );

  if (!fs.existsSync(deploymentFile)) {
    return null;
  }

  try {
    const data = fs.readFileSync(deploymentFile, 'utf8');
    return JSON.parse(data) as ContractAddresses;
  } catch (error) {
    console.error(`Failed to load contract addresses: ${error}`);
    return null;
  }
}

/**
 * Save contract addresses to deployment file
 */
export function saveContractAddresses(
  networkName: string,
  addresses: ContractAddresses
): void {
  const deploymentDir = path.join(process.cwd(), 'deployments', networkName);
  
  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true });
  }

  const deploymentFile = path.join(deploymentDir, 'addresses.json');
  fs.writeFileSync(deploymentFile, JSON.stringify(addresses, null, 2));
}

/**
 * Safely get a private key from environment variables.
 * Trims whitespace to prevent issues with keys copied with trailing newlines.
 */
export function getSafePrivateKey(): string | undefined {
  const rawKey = process.env.MOONLANDER_PRIVATE_KEY 
    || process.env.PRIVATE_KEY 
    || process.env.SERVER_WALLET_PRIVATE_KEY
    || process.env.AGENT_PRIVATE_KEY;
  return rawKey?.trim() || undefined;
}

/**
 * Application configuration
 */
export const config = {
  // Environment
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // Blockchain
  privateKey: (process.env.PRIVATE_KEY || '').trim(),
  deployerPrivateKey: (process.env.DEPLOYER_PRIVATE_KEY || '').trim(),
  
  // APIs
  cryptocomAiApiKey: process.env.CRYPTOCOM_DEVELOPER_API_KEY || process.env.CRYPTOCOM_AI_API_KEY || '',
  cryptocomApiSecret: process.env.CRYPTOCOM_API_SECRET || '',
  mcpServerUrl: process.env.MCP_SERVER_URL || 'https://mcp.crypto.com/market-data/mcp',
  mcpApiKey: process.env.MCP_API_KEY || '',
  cronoscanApiKey: process.env.CRONOSCAN_API_KEY || '',

  // dApp Integrations
  vvsRouterAddress: process.env.VVS_ROUTER_ADDRESS || '',
  moonlanderApiUrl: process.env.MOONLANDER_API_URL || '',
  delphiContractAddress: process.env.DELPHI_CONTRACT_ADDRESS || '',

  // Database
  databaseUrl: process.env.DATABASE_URL || '',
  dbHost: process.env.DB_HOST || 'localhost',
  dbPort: parseInt(process.env.DB_PORT || '5432', 10),
  dbName: process.env.DB_NAME || 'zk_vanguard',
  dbUser: process.env.DB_USER || 'zkward_user',
  dbPassword: process.env.DB_PASSWORD || '',

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),

  // Agent Configuration
  agentLogLevel: process.env.AGENT_LOG_LEVEL || 'info',
  agentMaxRetries: parseInt(process.env.AGENT_MAX_RETRIES || '3', 10),
  agentTimeout: parseInt(process.env.AGENT_TIMEOUT || '30000', 10),

  // ZK Configuration
  zkTrustedSetupPath: process.env.ZK_TRUSTED_SETUP_PATH || './zk/trusted-setup',
  zkCircuitPath: process.env.ZK_CIRCUIT_PATH || './zk/circuits',

  // Frontend
  apiUrl: process.env.VITE_API_URL || 'http://localhost:3000',
  wsUrl: process.env.VITE_WS_URL || 'ws://localhost:3000',
  chainId: parseInt(process.env.VITE_CHAIN_ID || '338', 10),

  // Simulator
  simulatorPort: parseInt(process.env.SIMULATOR_PORT || '3001', 10),
  simulatorDbPath: process.env.SIMULATOR_DB_PATH || './simulator/data',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  logFilePath: process.env.LOG_FILE_PATH || './logs',

  // Gas Configuration
  gasPriceMultiplier: parseFloat(process.env.GAS_PRICE_MULTIPLIER || '1.1'),
  maxGasLimit: parseInt(process.env.MAX_GAS_LIMIT || '8000000', 10),

  // Security - CRITICAL: These MUST be set in production
  // In development, generate random secrets to prevent accidental insecure deployments
  jwtSecret: process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : `dev-secret-${Date.now()}`),
  encryptionKey: process.env.ENCRYPTION_KEY || (process.env.NODE_ENV === 'production' ? '' : `dev-key-${Date.now()}`),

  // Monitoring
  sentryDsn: process.env.SENTRY_DSN || '',
  grafanaUrl: process.env.GRAFANA_URL || '',
  prometheusPort: parseInt(process.env.PROMETHEUS_PORT || '9090', 10),
};

/**
 * Validate required configuration
 */
export function validateConfig(): void {
  const required = ['privateKey'];
  
  if (config.isProduction) {
    required.push('cryptocomAiApiKey', 'mcpApiKey', 'jwtSecret', 'encryptionKey');
  }

  const missing = required.filter((key) => !config[key as keyof typeof config]);

  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
}

export default config;
