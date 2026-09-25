#!/usr/bin/env node
/**
 * SUI Move Contract Deployment Script
 * 
 * Deploys ZKward Move modules to SUI testnet/devnet/mainnet
 * 
 * Prerequisites:
 * 1. Install Sui CLI: cargo install --locked --git https://github.com/MystenLabs/sui.git --branch testnet sui
 * 2. Setup wallet: sui client new-address ed25519
 * 3. Get testnet tokens: sui client faucet
 * 
 * Usage:
 * - bun run deploy:sui:testnet
 * - bun run deploy:sui:devnet
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const NETWORKS = {
  testnet: {
    rpcUrl: 'https://fullnode.testnet.sui.io:443',
    faucetUrl: 'https://faucet.testnet.sui.io/v1/gas',
    explorerUrl: 'https://suiexplorer.com/?network=testnet',
  },
  devnet: {
    rpcUrl: 'https://fullnode.devnet.sui.io:443',
    faucetUrl: 'https://faucet.devnet.sui.io/v1/gas',
    explorerUrl: 'https://suiexplorer.com/?network=devnet',
  },
  mainnet: {
    rpcUrl: 'https://fullnode.mainnet.sui.io:443',
    faucetUrl: null,
    explorerUrl: 'https://suiexplorer.com',
  },
};

const CONTRACT_DIR = path.join(__dirname, '../../contracts/sui');
const DEPLOYMENTS_DIR = path.join(__dirname, '../../deployments');

// Ensure deployments directory exists
if (!fs.existsSync(DEPLOYMENTS_DIR)) {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
}

/**
 * Execute a command and return output
 */
function exec(command, options = {}) {
  try {
    const result = execSync(command, {
      encoding: 'utf-8',
      ...options,
    });
    return result.trim();
  } catch (error) {
    console.error(`Command failed: ${command}`);
    console.error(error.message);
    throw error;
  }
}

/**
 * Check if Sui CLI is installed
 */
function checkSuiCli() {
  try {
    const version = exec('sui --version');
    console.log(`✓ Sui CLI found: ${version}`);
    return true;
  } catch {
    console.error('✗ Sui CLI not found. Please install it:');
    console.error('  cargo install --locked --git https://github.com/MystenLabs/sui.git --branch testnet sui');
    return false;
  }
}

/**
 * Get active address from Sui wallet
 */
function getActiveAddress() {
  try {
    const output = exec('sui client active-address');
    console.log(`✓ Active address: ${output}`);
    return output;
  } catch {
    console.error('✗ No active address. Create one with: sui client new-address ed25519');
    return null;
  }
}

/**
 * Get gas balance
 */
async function getGasBalance(address, network) {
  try {
    const response = await fetch(NETWORKS[network].rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'suix_getBalance',
        params: [address, '0x2::sui::SUI'],
      }),
    });
    
    const data = await response.json();
    const balance = BigInt(data.result?.totalBalance || '0');
    const balanceInSui = Number(balance) / 1e9;
    console.log(`✓ Gas balance: ${balanceInSui.toFixed(4)} SUI`);
    return balance;
  } catch (error) {
    console.error('✗ Failed to get balance:', error.message);
    return BigInt(0);
  }
}

/**
 * Request faucet tokens
 */
async function requestFaucet(address, network) {
  if (!NETWORKS[network].faucetUrl) {
    console.log('⚠ Faucet not available for mainnet');
    return false;
  }

  console.log('Requesting tokens from faucet...');
  
  try {
    const response = await fetch(NETWORKS[network].faucetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        FixedAmountRequest: { recipient: address },
      }),
    });

    if (response.ok) {
      console.log('✓ Faucet request successful. Waiting for tokens...');
      // Wait a bit for tokens to arrive
      await new Promise(resolve => setTimeout(resolve, 5000));
      return true;
    } else {
      const error = await response.text();
      console.error('✗ Faucet request failed:', error);
      return false;
    }
  } catch (error) {
    console.error('✗ Faucet request failed:', error.message);
    return false;
  }
}

/**
 * Build Move package
 */
function buildPackage() {
  console.log('\n📦 Building Move package...');
  
  try {
    exec(`sui move build`, { cwd: CONTRACT_DIR });
    console.log('✓ Package built successfully');
    return true;
  } catch (error) {
    console.error('✗ Build failed');
    return false;
  }
}

/**
 * Deploy package to network
 */
async function deployPackage(network) {
  console.log(`\n🚀 Deploying to ${network}...`);
  
  try {
    // Set the network
    exec(`sui client switch --env ${network}`);
    console.log(`✓ Switched to ${network}`);
    
    // Publish the package
    const output = exec(
      `sui client publish --gas-budget 500000000 --json`,
      { cwd: CONTRACT_DIR }
    );
    
    const result = JSON.parse(output);
    
    if (result.effects?.status?.status !== 'success') {
      console.error('✗ Deployment failed:', result.effects?.status);
      return null;
    }

    // Extract important object IDs
    const deploymentInfo = {
      network,
      timestamp: new Date().toISOString(),
      digest: result.digest,
      packageId: null,
      objects: {
        rwaManagerState: null,
        zkVerifierState: null,
        paymentRouterState: null,
        adminCap: null,
      },
    };

    // Parse created objects
    for (const change of result.objectChanges || []) {
      if (change.type === 'published') {
        deploymentInfo.packageId = change.packageId;
      } else if (change.type === 'created') {
        const objectType = change.objectType;
        
        if (objectType.includes('RWAManagerState')) {
          deploymentInfo.objects.rwaManagerState = change.objectId;
        } else if (objectType.includes('ZKVerifierState')) {
          deploymentInfo.objects.zkVerifierState = change.objectId;
        } else if (objectType.includes('PaymentRouterState')) {
          deploymentInfo.objects.paymentRouterState = change.objectId;
        } else if (objectType.includes('AdminCap')) {
          // Multiple admin caps created, store as array
          if (!deploymentInfo.objects.adminCap) {
            deploymentInfo.objects.adminCap = [];
          }
          deploymentInfo.objects.adminCap.push(change.objectId);
        }
      }
    }

    console.log('✓ Deployment successful!');
    console.log(`  Package ID: ${deploymentInfo.packageId}`);
    console.log(`  Digest: ${deploymentInfo.digest}`);
    
    return deploymentInfo;
  } catch (error) {
    console.error('✗ Deployment failed:', error.message);
    return null;
  }
}

/**
 * Save deployment info
 */
function saveDeployment(deploymentInfo) {
  const filename = `sui-${deploymentInfo.network}-${Date.now()}.json`;
  const filepath = path.join(DEPLOYMENTS_DIR, filename);
  
  fs.writeFileSync(filepath, JSON.stringify(deploymentInfo, null, 2));
  console.log(`✓ Deployment saved to: ${filepath}`);
  
  // Also update the latest deployment file
  const latestPath = path.join(DEPLOYMENTS_DIR, `sui-${deploymentInfo.network}.json`);
  fs.writeFileSync(latestPath, JSON.stringify(deploymentInfo, null, 2));
  console.log(`✓ Latest deployment updated: ${latestPath}`);
  
  return filepath;
}

/**
 * Print environment variables for .env.local
 */
function printEnvVariables(deploymentInfo) {
  console.log('\n📝 Add these to your .env.local:');
  console.log('─'.repeat(50));
  console.log(`NEXT_PUBLIC_SUI_PACKAGE_ID=${deploymentInfo.packageId || ''}`);
  console.log(`NEXT_PUBLIC_SUI_RWA_MANAGER_STATE=${deploymentInfo.objects.rwaManagerState || ''}`);
  console.log(`NEXT_PUBLIC_SUI_ZK_VERIFIER_STATE=${deploymentInfo.objects.zkVerifierState || ''}`);
  console.log(`NEXT_PUBLIC_SUI_PAYMENT_ROUTER_STATE=${deploymentInfo.objects.paymentRouterState || ''}`);
  
  const adminCaps = deploymentInfo.objects.adminCap;
  if (Array.isArray(adminCaps) && adminCaps.length > 0) {
    console.log(`NEXT_PUBLIC_SUI_ADMIN_CAP=${adminCaps[0]}`);
  }
  console.log('─'.repeat(50));
}

/**
 * Main deployment function
 */
async function main() {
  const args = process.argv.slice(2);
  const network = args[0] || 'testnet';
  
  if (!['testnet', 'devnet', 'mainnet'].includes(network)) {
    console.error('Invalid network. Use: testnet, devnet, or mainnet');
    process.exit(1);
  }

  console.log('═'.repeat(50));
  console.log(`  ZKward SUI Deployment - ${network.toUpperCase()}`);
  console.log('═'.repeat(50));

  // Check prerequisites
  if (!checkSuiCli()) {
    process.exit(1);
  }

  const address = getActiveAddress();
  if (!address) {
    process.exit(1);
  }

  // Check balance
  let balance = await getGasBalance(address, network);
  
  // Request faucet if balance is low (less than 1 SUI)
  if (balance < BigInt(1e9) && network !== 'mainnet') {
    await requestFaucet(address, network);
    balance = await getGasBalance(address, network);
  }

  if (balance < BigInt(0.5e9)) {
    console.error('✗ Insufficient gas. Please fund your wallet.');
    console.error(`  Address: ${address}`);
    if (network !== 'mainnet') {
      console.error(`  Faucet: ${NETWORKS[network].faucetUrl}`);
    }
    process.exit(1);
  }

  // Build package
  if (!buildPackage()) {
    process.exit(1);
  }

  // Deploy
  const deploymentInfo = await deployPackage(network);
  
  if (!deploymentInfo) {
    process.exit(1);
  }

  // Save deployment
  saveDeployment(deploymentInfo);

  // Print env variables
  printEnvVariables(deploymentInfo);

  // Print explorer links
  console.log('\n🔗 Explorer Links:');
  console.log(`  Package: ${NETWORKS[network].explorerUrl}/object/${deploymentInfo.packageId}`);
  console.log(`  Transaction: ${NETWORKS[network].explorerUrl}/txblock/${deploymentInfo.digest}`);

  console.log('\n✅ Deployment complete!');
}

// Run
main().catch(console.error);
