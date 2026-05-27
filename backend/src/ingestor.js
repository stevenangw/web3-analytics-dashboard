/**
 * ingestor.js
 * ───────────────────────────────────────────────────────────────────────────────
 * Core ingestion engine for the Web3 Analytics Dashboard.
 *
 * Operates in two modes detected automatically at startup:
 *
 *   • **Hybrid / Sepolia mode** – when TRACKED_TOKEN_ADDRESS is set in .env,
 *     the ingestor connects to a public Sepolia RPC and tracks that token's
 *     Transfer events using a minimal ERC-20 ABI.
 *
 *   • **Local mode** – when no tracked address is configured, the ingestor
 *     reads the local Hardhat deployment artifact and uses the full contract
 *     ABI (including the custom WalletActivity event).
 *
 * Flow:
 *   1. Backfill: paginate through historical blocks in chunks, persisting
 *      every Transfer event + synthesised activities.
 *   2. Live listener: subscribe to real-time Transfer (+ WalletActivity) events.
 *   3. Polling fallback: every 30 s, sweep any blocks the listener may have
 *      missed (guards against WebSocket drops / provider hiccups).
 * ───────────────────────────────────────────────────────────────────────────────
 */

const path    = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const fs      = require('fs');
const { ethers } = require('ethers');

const {
  insertTokenTransfer,
  insertUserActivity,
  getLastProcessedBlock,
  setLastProcessedBlock,
} = require('./db');

const { generateChunks, queryWithRetry } = require('./utils/blockChunker');
const { synthesizeActivities }           = require('./utils/synthesizer');

// ── Block-timestamp cache ──────────────────────────────────────────────────
// Avoids redundant provider.getBlock() calls for the same block number.
// Implements a size-limited cache (max 5000 items) to prevent memory leaks.
const MAX_CACHE_SIZE = 5000;
const blockTimestampCache = new Map();
const blockTimestampCacheKeys = [];

function setBlockTimestampInCache(key, value) {
  if (!blockTimestampCache.has(key)) {
    blockTimestampCacheKeys.push(key);
  }
  blockTimestampCache.set(key, value);
  if (blockTimestampCacheKeys.length > MAX_CACHE_SIZE) {
    const oldestKey = blockTimestampCacheKeys.shift();
    blockTimestampCache.delete(oldestKey);
  }
}

/**
 * Fetch (and cache) the UNIX timestamp for a given block number.
 *
 * @param {import('ethers').JsonRpcProvider} provider
 * @param {number} blockNumber
 * @returns {Promise<string>} ISO-8601 timestamp string
 */
async function getBlockTimestamp(provider, blockNumber) {
  if (blockTimestampCache.has(blockNumber)) {
    return blockTimestampCache.get(blockNumber);
  }

  const block = await provider.getBlock(blockNumber);
  // block.timestamp is seconds since epoch
  const isoTimestamp = new Date(block.timestamp * 1000).toISOString();
  setBlockTimestampInCache(blockNumber, isoTimestamp);
  return isoTimestamp;
}

/**
 * Process a single Transfer event: persist the raw transfer row and
 * synthesise + persist the derived user-activity rows.
 *
 * @param {import('ethers').EventLog} event
 * @param {import('ethers').JsonRpcProvider} provider
 */
async function processTransferEvent(event, provider) {
  try {
    const blockNumber    = event.blockNumber;
    const blockTimestamp  = await getBlockTimestamp(provider, blockNumber);

    // ethers v6 returns args as a Result object; destructure by position
    const from  = event.args[0];
    const to    = event.args[1];
    const value = event.args[2].toString(); // BigInt → string for Postgres NUMERIC

    const txHash = event.transactionHash;

    // Fetch gas information from the transaction receipt
    let gasUsed  = null;
    let gasPrice = null;

    // Safety check: Only query receipts on local node OR for high value (whale) transfers to prevent RPC congestion/rate limiting
    const isLocal = !process.env.TRACKED_TOKEN_ADDRESS;
    const isWhale = BigInt(value) >= BigInt("1000000000000000000000"); // >= 1,000 tokens

    if (isLocal || isWhale) {
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt) {
          gasUsed  = receipt.gasUsed.toString();
          gasPrice = receipt.gasPrice ? receipt.gasPrice.toString() : null;
        }
      } catch (gasErr) {
        // Non-critical — proceed without gas data
        console.warn(`[Ingestor] ⚠ Could not fetch gas info for ${txHash}: ${gasErr.message}`);
      }
    }

    // 1. Persist raw transfer
    await insertTokenTransfer({
      transactionHash: txHash,
      blockNumber,
      blockTimestamp,
      from,
      to,
      value,
      gasUsed,
      gasPrice,
    });

    // 2. Synthesise and persist user activities
    const activities = synthesizeActivities({
      transactionHash: txHash,
      blockNumber,
      blockTimestamp,
      from,
      to,
      value,
    });

    for (const activity of activities) {
      await insertUserActivity(activity);
    }
  } catch (err) {
    console.error(`[Ingestor] ✖ Error processing Transfer event: ${err.message}`);
  }
}

/**
 * Boot the ingestion engine.
 *
 * @returns {Promise<{ mode: string, tokenAddress: string, status: string }>}
 */
async function startIngestor() {
  // ── 1. Load environment ──────────────────────────────────────────────────
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

  // ── 2. Mode detection ───────────────────────────────────────────────────
  let tokenAddress, rpcUrl, abi, mode;

  const trackedAddress = process.env.TRACKED_TOKEN_ADDRESS;

  if (trackedAddress && trackedAddress.trim() !== '') {
    // ── Hybrid / Sepolia mode ──────────────────────────────────────────────
    tokenAddress = trackedAddress.trim();
    rpcUrl       = process.env.SEPOLIA_RPC_URL || 'https://rpc.sepolia.org';
    abi          = require('./abi/ERC20Standard.json');
    mode         = 'hybrid';
    console.log(`[Ingestor] 🌐 Hybrid mode: tracking external token at ${tokenAddress} on Sepolia`);
  } else {
    // ── Local / Hardhat mode ───────────────────────────────────────────────
    const deploymentPath = path.resolve(__dirname, '../../blockchain/deployments/deployment.json');

    if (!fs.existsSync(deploymentPath)) {
      console.error(`[Ingestor] ✖ No deployment found at ${deploymentPath}. Deploy the contract first or set TRACKED_TOKEN_ADDRESS.`);
      return { mode: 'error', tokenAddress: null, status: 'no_deployment' };
    }

    const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf-8'));
    tokenAddress     = deployment.address;
    abi              = deployment.abi;
    rpcUrl           = 'http://127.0.0.1:8545';
    mode             = 'local';
    console.log(`[Ingestor] 🏠 Local mode: tracking deployed token at ${tokenAddress}`);
  }

  // ── 3. Provider & contract ───────────────────────────────────────────────
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(tokenAddress, abi, provider);

  // ── 4. Backfill historical events ────────────────────────────────────────
  try {
    let lastBlock     = await getLastProcessedBlock();
    const currentBlock = await provider.getBlockNumber();

    if (lastBlock === null) {
      // First run — backfill the most recent 1000 blocks (or from genesis)
      lastBlock = Math.max(0, currentBlock - 1000);
      console.log(`[Ingestor] 🆕 No checkpoint found. Starting backfill from block ${lastBlock}`);
    } else {
      // Safety Clamp: prevent massive historical queries (e.g. when switching from localhost to Sepolia)
      if (currentBlock - lastBlock > 5000) {
        const clampedBlock = Math.max(0, currentBlock - 1000);
        console.log(
          `[Ingestor] ⚠️  Large gap detected (${currentBlock - lastBlock} blocks) likely due to network change. ` +
          `Clamping backfill to start from block ${clampedBlock} to protect RPC node from rate-limiting.`
        );
        lastBlock = clampedBlock;
      } else {
        console.log(`[Ingestor] 🔄 Resuming backfill from block ${lastBlock + 1}`);
        lastBlock += 1; // don't re-process the last completed block
      }
    }

    const chunks = generateChunks(lastBlock, currentBlock);
    console.log(`[Ingestor] 📦 Backfilling ${chunks.length} chunk(s) from ${lastBlock} to ${currentBlock}`);

    const transferFilter = contract.filters.Transfer();

    for (const chunk of chunks) {
      const events = await queryWithRetry(contract, transferFilter, chunk.from, chunk.to);

      for (const event of events) {
        await processTransferEvent(event, provider);
      }

      // Checkpoint after every chunk so we never re-process on restart
      await setLastProcessedBlock(chunk.to);
      console.log(
        `[Ingestor] ✔ Backfilled chunk ${chunk.from}-${chunk.to}, found ${events.length} event(s)`
      );
    }

    console.log('[Ingestor] ✅ Backfill complete');
  } catch (err) {
    console.error(`[Ingestor] ✖ Backfill error: ${err.message}`);
    // Continue to live listener even if backfill partially failed — the
    // checkpoint ensures we can resume later.
  }

  // ── 5. Live event listener ───────────────────────────────────────────────
  console.log('[Ingestor] 👂 Starting live event listener…');

  contract.on('Transfer', async (from, to, value, event) => {
    console.log(`[Ingestor] 📡 Live Transfer detected in tx ${event.log.transactionHash}`);
    try {
      // Build a synthetic event-like object compatible with processTransferEvent
      const syntheticEvent = {
        blockNumber:     event.log.blockNumber,
        transactionHash: event.log.transactionHash,
        args: [from, to, value],
      };
      await processTransferEvent(syntheticEvent, provider);
      await setLastProcessedBlock(event.log.blockNumber);
    } catch (err) {
      console.error(`[Ingestor] ✖ Live listener error: ${err.message}`);
    }
  });

  // If the full ABI includes WalletActivity (local mode), listen for that too
  if (mode === 'local') {
    try {
      const walletActivityFilter = contract.filters.WalletActivity;
      if (walletActivityFilter) {
        contract.on('WalletActivity', async (...args) => {
          const event = args[args.length - 1]; // last arg is the ContractEventPayload
          console.log(`[Ingestor] 📡 Live WalletActivity detected in block ${event.log.blockNumber}`);
          // WalletActivity events are informational; log them for now.
          // Extend with custom persistence logic as the schema evolves.
        });
        console.log('[Ingestor] 👂 Also listening for WalletActivity events (local mode)');
      }
    } catch {
      // ABI doesn't include WalletActivity — that's fine
      console.log('[Ingestor] ℹ WalletActivity event not found in ABI, skipping listener');
    }
  }

  // ── 6. Polling fallback ──────────────────────────────────────────────────
  // Every 30 seconds, check for blocks the live listener may have missed.
  const POLL_INTERVAL_MS = 30_000;

  const pollInterval = setInterval(async () => {
    try {
      const lastProcessed = await getLastProcessedBlock();
      const latestBlock   = await provider.getBlockNumber();

      if (lastProcessed !== null && latestBlock > lastProcessed) {
        const transferFilter = contract.filters.Transfer();
        const chunks = generateChunks(lastProcessed + 1, latestBlock);

        for (const chunk of chunks) {
          const events = await queryWithRetry(contract, transferFilter, chunk.from, chunk.to);

          for (const event of events) {
            await processTransferEvent(event, provider);
          }

          await setLastProcessedBlock(chunk.to);

          if (events.length > 0) {
            console.log(
              `[Ingestor] 🔄 Poll sweep: blocks ${chunk.from}-${chunk.to}, found ${events.length} event(s)`
            );
          }
        }
      }
    } catch (err) {
      console.error(`[Ingestor] ✖ Poll sweep error: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);

  // Prevent the interval from keeping the process alive if everything else
  // shuts down (e.g. during graceful exit).
  pollInterval.unref();

  console.log(`[Ingestor] 🔄 Polling fallback active (every ${POLL_INTERVAL_MS / 1000}s)`);

  // ── 7. Return status summary ────────────────────────────────────────────
  return {
    mode,
    tokenAddress,
    status: 'running',
  };
}

module.exports = { startIngestor };
