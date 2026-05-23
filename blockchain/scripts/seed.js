// --------------------------------------------------------------------------
// seed.js – Populate the local chain with realistic token transfer activity
// --------------------------------------------------------------------------
// Reads the deployed contract address from deployments/deployment.json,
// then performs ~20 randomised transfers between Hardhat signers so the
// analytics dashboard has meaningful data to display.
//
// Usage:
//   npx hardhat run scripts/seed.js --network localhost
// --------------------------------------------------------------------------

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Pause execution for the given number of milliseconds.
 * Small delays between transactions keep the local node responsive and
 * produce distinct block timestamps for more realistic analytics data.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Return a random integer between `min` and `max` (inclusive).
 */
function randomAmount(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  // ---- Load deployment manifest ----
  const deploymentPath = path.join(__dirname, "..", "deployments", "deployment.json");

  if (!fs.existsSync(deploymentPath)) {
    console.error("❌ deployments/deployment.json not found. Run deploy first.");
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  console.log("📄 Loaded deployment at", deployment.address, "on", deployment.network);

  // ---- Connect to the deployed token ----
  const signers = await hre.ethers.getSigners();
  const token = await hre.ethers.getContractAt("AnalyticsToken", deployment.address);

  const owner = signers[0];
  const decimals = await token.decimals();

  console.log(`\n👤 Owner          : ${owner.address}`);
  console.log(`🪙  Token decimals : ${decimals}`);
  console.log(`💰 Owner balance  : ${hre.ethers.formatUnits(await token.balanceOf(owner.address), decimals)} ANLT`);

  // ---- Define seed transfers ----
  // We spread tokens from the owner (signer 0) to several other signers,
  // then have those signers trade among themselves for varied activity.
  const transfers = [
    // Phase 1 – Owner distributes tokens to signers 1-5
    { from: 0, to: 1, amount: randomAmount(5000, 10000) },
    { from: 0, to: 2, amount: randomAmount(5000, 10000) },
    { from: 0, to: 3, amount: randomAmount(5000, 10000) },
    { from: 0, to: 4, amount: randomAmount(5000, 10000) },
    { from: 0, to: 5, amount: randomAmount(5000, 10000) },

    // Phase 2 – Peer-to-peer transfers
    { from: 1, to: 2, amount: randomAmount(100, 2000) },
    { from: 2, to: 3, amount: randomAmount(100, 2000) },
    { from: 3, to: 4, amount: randomAmount(100, 2000) },
    { from: 4, to: 5, amount: randomAmount(100, 2000) },
    { from: 5, to: 1, amount: randomAmount(100, 2000) },

    // Phase 3 – More varied activity
    { from: 1, to: 3, amount: randomAmount(200, 3000) },
    { from: 2, to: 5, amount: randomAmount(200, 3000) },
    { from: 3, to: 1, amount: randomAmount(200, 3000) },
    { from: 4, to: 2, amount: randomAmount(200, 3000) },
    { from: 5, to: 4, amount: randomAmount(200, 3000) },

    // Phase 4 – Small rapid-fire transfers
    { from: 1, to: 4, amount: randomAmount(100, 500) },
    { from: 2, to: 1, amount: randomAmount(100, 500) },
    { from: 3, to: 5, amount: randomAmount(100, 500) },
    { from: 4, to: 3, amount: randomAmount(100, 500) },
    { from: 5, to: 2, amount: randomAmount(100, 500) },
  ];

  console.log(`\n🔄 Executing ${transfers.length} seed transfers...\n`);

  for (let i = 0; i < transfers.length; i++) {
    const { from, to, amount } = transfers[i];
    const sender = signers[from];
    const receiver = signers[to];
    const rawAmount = hre.ethers.parseUnits(amount.toString(), decimals);

    const tx = await token.connect(sender).transfer(receiver.address, rawAmount);
    await tx.wait();

    console.log(
      `  [${(i + 1).toString().padStart(2, "0")}/${transfers.length}] ` +
      `${sender.address.slice(0, 8)}…${sender.address.slice(-4)} → ` +
      `${receiver.address.slice(0, 8)}…${receiver.address.slice(-4)} | ` +
      `${amount.toLocaleString().padStart(6)} ANLT | tx ${tx.hash.slice(0, 14)}…`
    );

    // Small delay to spread out block timestamps
    await sleep(100);
  }

  // ---- Summary ----
  console.log("\n📊 Final balances:");
  for (let i = 0; i <= 5; i++) {
    const balance = await token.balanceOf(signers[i].address);
    console.log(
      `  Signer ${i}: ${signers[i].address.slice(0, 10)}… = ` +
      `${hre.ethers.formatUnits(balance, decimals)} ANLT`
    );
  }

  console.log("\n🎉 Seeding complete!\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  });
