// --------------------------------------------------------------------------
// deploy.js – Deploy AnalyticsToken and persist deployment artifacts
// --------------------------------------------------------------------------
// Usage:
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/deploy.js --network sepolia
// --------------------------------------------------------------------------

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("🚀 Deploying AnalyticsToken...\n");

  // ---- Deployer info ----
  const [deployer] = await hre.ethers.getSigners();
  console.log("  Deployer address :", deployer.address);
  console.log(
    "  Deployer balance :",
    hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)),
    "ETH"
  );

  // ---- Deploy contract ----
  const initialSupply = 1_000_000;
  const AnalyticsToken = await hre.ethers.getContractFactory("AnalyticsToken");
  const token = await AnalyticsToken.deploy(initialSupply);
  await token.waitForDeployment();

  const contractAddress = await token.getAddress();
  const networkName = hre.network.name;

  console.log("\n  ✅ AnalyticsToken deployed!");
  console.log("  Contract address :", contractAddress);
  console.log("  Network          :", networkName);
  console.log("  Initial supply   :", initialSupply.toLocaleString(), "ANLT");

  // ---- Read the compiled ABI ----
  const artifact = await hre.artifacts.readArtifact("AnalyticsToken");

  // ---- Persist deployment manifest ----
  const deploymentsDir = path.join(__dirname, "..", "deployments");

  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
    console.log("\n  📁 Created deployments/ directory");
  }

  const deployment = {
    address: contractAddress,
    network: networkName,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    abi: artifact.abi,
  };

  const deploymentPath = path.join(deploymentsDir, "deployment.json");
  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));
  console.log("  💾 Deployment manifest saved to deployments/deployment.json");

  console.log("\n🎉 Deployment complete!\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });
