/**
 * trafficGenerator.js
 * ───────────────────────────────────────────────────────────────────────────────
 * Background Traffic Generator for Web3 Analytics Dashboard.
 *
 * Automatically simulates token transfers to random addresses at regular intervals.
 * 
 * Safety Features:
 *   • Balance Check: Stops generating transactions if Sepolia ETH balance is < 0.05 ETH.
 *   • Error Isolation: Wrapped in try/catch to ensure server never crashes.
 *   • Smart Contract Config: Reads directly from local config or environment variables.
 * ───────────────────────────────────────────────────────────────────────────────
 */

const { ethers } = require('ethers');
const path = require('path');
const fs = require('fs');

// Minimal ABI required for balance check and transfers
const MINIMAL_ERC20_ABI = [
  "function transfer(address to, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)"
];

// Safety thresholds
const ETH_SAFETY_LIMIT = 0.05; // Stop sending transactions if Sepolia ETH is less than this

/**
 * Generate a single simulated token transfer transaction.
 */
async function generateTraffic() {
  try {
    const tokenAddress = process.env.TRACKED_TOKEN_ADDRESS;
    const rpcUrl = process.env.SEPOLIA_RPC_URL;
    const privateKey = process.env.DEPLOYER_PRIVATE_KEY;

    // Check credentials
    if (!tokenAddress || !rpcUrl || !privateKey) {
      console.log('[TrafficGenerator] ℹ Disabled: Missing Sepolia credentials or TRACKED_TOKEN_ADDRESS.');
      return;
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    // 1. Safety Check: Verify Sepolia ETH balance for gas fees
    const ethBalanceWei = await provider.getBalance(wallet.address);
    const ethBalance = parseFloat(ethers.formatEther(ethBalanceWei));

    console.log(`[TrafficGenerator] ⛽ Current wallet balance: ${ethBalance.toFixed(5)} Sepolia ETH`);

    if (ethBalance < ETH_SAFETY_LIMIT) {
      console.warn(
        `[TrafficGenerator] ⚠️ WARNING: Sepolia ETH balance is too low (${ethBalance.toFixed(5)} ETH). ` +
        `Safety limit is ${ETH_SAFETY_LIMIT} ETH. Stopping transaction generation to protect your gas wallet.`
      );
      return;
    }

    // 2. Connect to the contract
    const tokenContract = new ethers.Contract(tokenAddress, MINIMAL_ERC20_ABI, wallet);

    // Check ANLT token balance
    const decimals = await tokenContract.decimals();
    const tokenBalanceWei = await tokenContract.balanceOf(wallet.address);
    const tokenBalance = parseFloat(ethers.formatUnits(tokenBalanceWei, decimals));

    console.log(`[TrafficGenerator] 🪙  Current token balance: ${tokenBalance.toLocaleString()} ANLT`);

    if (tokenBalance <= 0) {
      console.warn('[TrafficGenerator] ⚠️ WARNING: Token balance is 0. Cannot send transfers.');
      return;
    }

    // 3. Generate random recipient and transfer amount (5 to 50 tokens)
    const randomAmount = Math.floor(Math.random() * 45) + 5;
    const rawAmount = ethers.parseUnits(randomAmount.toString(), decimals);

    // Make sure we have enough tokens to send
    if (tokenBalance < randomAmount) {
      console.warn('[TrafficGenerator] ⚠️ WARNING: Insufficient token balance for simulated transfer.');
      return;
    }

    const randomRecipient = ethers.Wallet.createRandom().address;

    console.log(`[TrafficGenerator] 🔄 Initiating transfer: ${randomAmount} ANLT → ${randomRecipient}...`);

    // 4. Send transaction
    const tx = await tokenContract.transfer(randomRecipient, rawAmount);
    console.log(`[TrafficGenerator] 📡 Broadcasted tx: ${tx.hash}`);

    // Wait for 1 confirmation
    const receipt = await tx.wait();
    console.log(
      `[TrafficGenerator] ✅ Confirmed! Block: ${receipt.blockNumber} | ` +
      `Simulated transfer of ${randomAmount} ANLT successful!`
    );

  } catch (err) {
    console.error('[TrafficGenerator] ✖ Error during traffic generation:', err.message);
  }
}

/**
 * Start the automatic background loop.
 * 
 * @param {number} intervalMs How often to generate a transaction (default: 15 minutes)
 */
function startTrafficGenerator(intervalMs = 900000) {
  const tokenAddress = process.env.TRACKED_TOKEN_ADDRESS;
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;

  if (!tokenAddress || !privateKey) {
    console.log('[TrafficGenerator] ℹ Not started (no private key or tracked token address configured).');
    return;
  }

  console.log(`[TrafficGenerator] 🚀 Background Traffic Generator activated.`);
  console.log(`[TrafficGenerator] ⏱️ Interval configured: every ${intervalMs / 1000 / 60} minutes.`);
  console.log(`[TrafficGenerator] 🛡️ Safety threshold set to: ${ETH_SAFETY_LIMIT} Sepolia ETH.`);

  // Trigger an initial transaction after a short 10-second delay so it's visible on startup
  setTimeout(() => {
    console.log('[TrafficGenerator] 🚀 Triggering startup simulation transaction...');
    generateTraffic();
  }, 10000);

  // Set the recurring timer
  const timer = setInterval(() => {
    console.log('[TrafficGenerator] ⏰ Triggering scheduled simulation transaction...');
    generateTraffic();
  }, intervalMs);

  // Prevent keeping the Node process alive if everything else is shut down
  timer.unref();
}

module.exports = { startTrafficGenerator };
