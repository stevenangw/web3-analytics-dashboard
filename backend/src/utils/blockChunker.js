/**
 * blockChunker.js
 * ───────────────────────────────────────────────────────────────────────────────
 * Utilities for paginating large block ranges into manageable chunks and
 * querying on-chain event logs with automatic exponential-backoff retry logic.
 *
 * RPCs impose limits on the block range per eth_getLogs call; chunking keeps
 * every request well within those limits while retry logic absorbs transient
 * rate-limit and server errors that are common with public endpoints.
 * ───────────────────────────────────────────────────────────────────────────────
 */

/**
 * Partition a block range [startBlock, endBlock] into an array of
 * non-overlapping {from, to} sub-ranges of at most `chunkSize` blocks each.
 *
 * @param {number} startBlock  - First block (inclusive)
 * @param {number} endBlock    - Last block (inclusive)
 * @param {number} chunkSize   - Maximum blocks per chunk (default 1000)
 * @returns {{ from: number, to: number }[]}
 */
function generateChunks(startBlock, endBlock, chunkSize = 1000) {
  const chunks = [];

  // Nothing to do when the range is empty or inverted
  if (startBlock > endBlock) {
    return chunks;
  }

  for (let from = startBlock; from <= endBlock; from += chunkSize) {
    const to = Math.min(from + chunkSize - 1, endBlock);
    chunks.push({ from, to });
  }

  return chunks;
}

/**
 * Query a contract's event logs within a block range, retrying on transient
 * errors with exponential back-off.
 *
 * Recognised retryable conditions:
 *   • HTTP 429 / rate-limit responses
 *   • Server errors (code -32000 … -32099 in JSON-RPC)
 *   • Generic timeout / ETIMEDOUT / ECONNRESET errors
 *   • "filter not found" responses (node pruned the pending filter)
 *
 * @param {import('ethers').Contract} contract   - ethers v6 Contract instance
 * @param {import('ethers').ContractEventName} filter - Event filter / name
 * @param {number}  fromBlock   - Start block (inclusive)
 * @param {number}  toBlock     - End block (inclusive)
 * @param {number}  maxRetries  - Maximum retry attempts (default 3)
 * @param {number}  baseDelay   - Base delay in ms before first retry (default 2000)
 * @returns {Promise<import('ethers').EventLog[]>}
 */
async function queryWithRetry(contract, filter, fromBlock, toBlock, maxRetries = 3, baseDelay = 2000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const events = await contract.queryFilter(filter, fromBlock, toBlock);
      return events;
    } catch (error) {
      const errorMsg = (error.message || '').toLowerCase();
      const errorCode = error.code || '';

      // Determine if the error is retryable
      const isRateLimit  = errorMsg.includes('rate') || errorMsg.includes('429') || errorMsg.includes('too many request');
      const isTimeout    = errorMsg.includes('timeout') || errorCode === 'ETIMEDOUT' || errorCode === 'ECONNRESET';
      const isServerErr  = errorMsg.includes('server_error') || errorCode === 'SERVER_ERROR';
      const isFilterGone = errorMsg.includes('filter not found');
      const isRetryable  = isRateLimit || isTimeout || isServerErr || isFilterGone;

      if (isRetryable && attempt < maxRetries) {
        // Exponential back-off: baseDelay * 2^attempt  (e.g. 2s → 4s → 8s)
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(
          `[BlockChunker] ⚠ Retryable error querying blocks ${fromBlock}-${toBlock} ` +
          `(attempt ${attempt + 1}/${maxRetries}): ${error.message}. ` +
          `Retrying in ${delay}ms…`
        );
        await sleep(delay);
        continue; // retry the loop
      }

      // Non-retryable or out of retries — propagate the error
      console.error(
        `[BlockChunker] ✖ Failed to query blocks ${fromBlock}-${toBlock} ` +
        `after ${attempt + 1} attempt(s): ${error.message}`
      );
      throw error;
    }
  }
}

/**
 * Promise-based sleep helper.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  generateChunks,
  queryWithRetry,
};
