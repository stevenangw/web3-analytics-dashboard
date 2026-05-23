/**
 * synthesizer.js
 * ───────────────────────────────────────────────────────────────────────────────
 * Derives higher-level "user activity" records from raw ERC-20 Transfer events.
 *
 * A single Transfer can produce up to two activity rows:
 *   • TRANSFER – the sender's outgoing activity  (skipped for mints)
 *   • RECEIVE  – the recipient's incoming activity (skipped for burns)
 *
 * The zero address (0x000…000) is the canonical mint/burn sentinel in ERC-20.
 * ───────────────────────────────────────────────────────────────────────────────
 */

/** The Ethereum zero address — used to detect mints and burns */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Synthesise user-level activity records from a single transfer event.
 *
 * @param {Object} transferEvent
 * @param {string} transferEvent.transactionHash  - Tx hash (0x-prefixed, 66 chars)
 * @param {number} transferEvent.blockNumber       - Block in which the event was mined
 * @param {string} transferEvent.blockTimestamp     - ISO-8601 timestamp of the block
 * @param {string} transferEvent.from               - Sender address (42 chars)
 * @param {string} transferEvent.to                 - Recipient address (42 chars)
 * @param {string} transferEvent.value              - Transfer value as a decimal string
 * @returns {{ transactionHash: string, walletAddress: string, activityType: string, amount: string, blockNumber: number, blockTimestamp: string }[]}
 */
function synthesizeActivities(transferEvent) {
  const {
    transactionHash,
    blockNumber,
    blockTimestamp,
    from,
    to,
    value,
  } = transferEvent;

  const activities = [];

  // Sender activity — skip when `from` is the zero address (token mint)
  if (from !== ZERO_ADDRESS) {
    activities.push({
      transactionHash,
      walletAddress: from,
      activityType: 'TRANSFER',
      amount: value,
      blockNumber,
      blockTimestamp,
    });
  }

  // Recipient activity — skip when `to` is the zero address (token burn)
  if (to !== ZERO_ADDRESS) {
    activities.push({
      transactionHash,
      walletAddress: to,
      activityType: 'RECEIVE',
      amount: value,
      blockNumber,
      blockTimestamp,
    });
  }

  return activities;
}

module.exports = { synthesizeActivities };
