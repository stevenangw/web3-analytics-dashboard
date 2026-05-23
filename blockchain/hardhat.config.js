// --------------------------------------------------------------------------
// hardhat.config.js – CommonJS Hardhat configuration
// --------------------------------------------------------------------------
// Loads environment variables from the *parent* directory's .env file so the
// mono-repo root can hold a single shared config (RPC URLs, private keys).
// --------------------------------------------------------------------------

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
require("@nomicfoundation/hardhat-toolbox");

// Gracefully handle missing Sepolia credentials – default to empty values so
// Hardhat can still start for local-only workflows.
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },

  networks: {
    // Default in-process Hardhat network (used by `npx hardhat test`)
    hardhat: {},

    // Standalone local node started with `npx hardhat node`
    localhost: {
      url: "http://127.0.0.1:8545",
    },

    // Ethereum Sepolia testnet – only usable when env vars are configured
    sepolia: {
      url: SEPOLIA_RPC_URL,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};
