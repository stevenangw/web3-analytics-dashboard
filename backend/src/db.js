/**
 * db.js
 * ───────────────────────────────────────────────────────────────────────────────
 * PostgreSQL data-access layer for the Web3 Analytics Dashboard.
 *
 * Manages a connection pool, schema initialisation (idempotent), and all
 * CRUD helpers needed by the ingestor and API routes.
 *
 * Environment variables consumed:
 *   DB_USER, DB_PASSWORD, DB_NAME, DB_HOST, DB_PORT
 * ───────────────────────────────────────────────────────────────────────────────
 */

const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Pool configuration — reads from process.env at import time
// ---------------------------------------------------------------------------
const isLocalDb = (process.env.DB_HOST || 'localhost') === 'localhost' || (process.env.DB_HOST || '') === '127.0.0.1';
const pool = new Pool({
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME     || 'web3analytics',
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT, 10) || 5432,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },

  // Tuning knobs
  max:                    20,     // max simultaneous connections
  idleTimeoutMillis:      30000,  // close idle clients after 30 s
  connectionTimeoutMillis: 5000,  // fail fast if PG is unreachable
});

// Surface unexpected pool-level errors instead of crashing silently
pool.on('error', (err) => {
  console.error('[DB] ✖ Unexpected pool error:', err.message);
});

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

/**
 * Create all required tables and constraints idempotently.
 * Safe to call on every server start.
 */
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── token_transfers ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS token_transfers (
        id                SERIAL PRIMARY KEY,
        transaction_hash  VARCHAR(66)    NOT NULL,
        block_number      BIGINT         NOT NULL,
        block_timestamp   TIMESTAMPTZ    NOT NULL,
        from_address      VARCHAR(42)    NOT NULL,
        to_address        VARCHAR(42)    NOT NULL,
        value             NUMERIC(78,0)  NOT NULL,
        gas_used          BIGINT,
        gas_price         NUMERIC(78,0),
        created_at        TIMESTAMPTZ    DEFAULT NOW(),
        UNIQUE(transaction_hash)
      );
    `);

    // ── user_activities ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_activities (
        id                SERIAL PRIMARY KEY,
        transaction_hash  VARCHAR(66)    NOT NULL,
        wallet_address    VARCHAR(42)    NOT NULL,
        activity_type     VARCHAR(20)    NOT NULL,
        amount            NUMERIC(78,0)  NOT NULL,
        block_number      BIGINT         NOT NULL,
        block_timestamp   TIMESTAMPTZ    NOT NULL,
        created_at        TIMESTAMPTZ    DEFAULT NOW()
      );
    `);

    // ── _meta (key-value store for checkpoints) ────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS _meta (
        key   VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // ── Add unique constraint (idempotent via DO/EXCEPTION block) ──────────
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE user_activities
          ADD CONSTRAINT uq_user_activities_tx_wallet_type
          UNIQUE (transaction_hash, wallet_address, activity_type);
      EXCEPTION
        WHEN duplicate_table THEN
          -- Constraint already exists; nothing to do
          NULL;
      END $$;
    `);

    // ── Create Indexes for Performance ──────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transfers_timestamp ON token_transfers(block_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_activities_wallet ON user_activities(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON user_activities(block_timestamp DESC);
    `);

    await client.query('COMMIT');
    console.log('[DB] ✔ Database schema initialised successfully');

    // ── Seed Realistic History if Empty ────────────────────────────────────
    const countRes = await client.query('SELECT COUNT(*)::int AS count FROM token_transfers');
    if (countRes.rows[0].count === 0) {
      console.log('[DB] 🆕 Database is empty! Seeding realistic mock history for high-fidelity demonstration...');
      await seedMockData(client);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] ✖ Schema initialisation failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

/**
 * Persist a raw token transfer row. Silently skips duplicates (same tx hash).
 *
 * @param {Object} data
 * @param {string} data.transactionHash
 * @param {number} data.blockNumber
 * @param {string} data.blockTimestamp   - ISO-8601 string
 * @param {string} data.from
 * @param {string} data.to
 * @param {string} data.value           - Decimal string (BigInt safe)
 * @param {string|null} data.gasUsed
 * @param {string|null} data.gasPrice
 */
async function insertTokenTransfer(data) {
  const query = `
    INSERT INTO token_transfers
      (transaction_hash, block_number, block_timestamp, from_address, to_address, value, gas_used, gas_price)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (transaction_hash) DO NOTHING;
  `;
  const values = [
    data.transactionHash,
    data.blockNumber,
    data.blockTimestamp,
    data.from,
    data.to,
    data.value,
    data.gasUsed  ?? null,
    data.gasPrice ?? null,
  ];
  await pool.query(query, values);
}

/**
 * Persist a synthesised user-activity row. Skips duplicates on the composite
 * unique constraint (transaction_hash, wallet_address, activity_type).
 *
 * @param {Object} data
 * @param {string} data.transactionHash
 * @param {string} data.walletAddress
 * @param {string} data.activityType   - e.g. 'TRANSFER' | 'RECEIVE'
 * @param {string} data.amount         - Decimal string
 * @param {number} data.blockNumber
 * @param {string} data.blockTimestamp
 */
async function insertUserActivity(data) {
  const query = `
    INSERT INTO user_activities
      (transaction_hash, wallet_address, activity_type, amount, block_number, block_timestamp)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (transaction_hash, wallet_address, activity_type) DO NOTHING;
  `;
  const values = [
    data.transactionHash,
    data.walletAddress,
    data.activityType,
    data.amount,
    data.blockNumber,
    data.blockTimestamp,
  ];
  await pool.query(query, values);
}

/**
 * Retrieve the last block number that was fully processed, or null if no
 * checkpoint has been stored yet.
 *
 * @returns {Promise<number|null>}
 */
async function getLastProcessedBlock() {
  const result = await pool.query(
    `SELECT value FROM _meta WHERE key = 'last_processed_block'`
  );
  if (result.rows.length === 0) return null;
  return parseInt(result.rows[0].value, 10);
}

/**
 * Upsert the last-processed-block checkpoint.
 *
 * @param {number} blockNumber
 */
async function setLastProcessedBlock(blockNumber) {
  await pool.query(
    `INSERT INTO _meta (key, value)
     VALUES ('last_processed_block', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1;`,
    [String(blockNumber)]
  );
}

/**
 * Seed realistic mock data into the database when it is empty.
 * This guarantees the user has a beautiful, live-like dashboard on first launch.
 */
async function seedMockData(client) {
  const wallets = [
    '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    '0x219089e13C124294b4E156D15E5aB271EBe8EF5a',
    '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    '0x90F8bf65DCCf6E6417b5d61d6CA406d4838a53a9',
    '0x2546BcD3c84621e976d8185a91A922aE77ECEc30',
    '0xbDA5747bFD65F08deb54cb465eB87D40e51B197E',
    '0xdD2FD4581271e230360230F9337D5c0430BF44C0',
    '0x8626f6940F27719541229b4e04899532D9dc1065',
    '0xECbE507cCE55d64287F8d39fD5c6999a0E344d56',
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
  ];

  const now = Date.now();
  const transfers = [];
  const activities = [];

  for (let i = 80; i >= 1; i--) {
    const ageMs = i * 9 * 3600 * 1000; // one every 9 hours
    const timestamp = new Date(now - ageMs).toISOString();
    const fromIdx = Math.floor(Math.random() * wallets.length);
    let toIdx = Math.floor(Math.random() * wallets.length);
    while (toIdx === fromIdx) {
      toIdx = Math.floor(Math.random() * wallets.length);
    }

    const from = wallets[fromIdx];
    const to = wallets[toIdx];
    const value = Math.floor(Math.random() * 4900) + 100; // 100 to 5000 tokens
    const valueWei = value.toString() + '000000000000000000'; // 18 decimals
    const blockNumber = 12000000 + (80 - i) * 5;
    const gasUsed = Math.floor(Math.random() * 30000) + 21000;
    const gasPrice = (Math.floor(Math.random() * 20) + 15).toString() + '000000000'; // 15 to 35 Gwei
    const txHash = '0x' + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join('');

    transfers.push({
      txHash,
      blockNumber,
      timestamp,
      from,
      to,
      value: valueWei,
      gasUsed,
      gasPrice
    });

    activities.push({
      txHash,
      wallet: from,
      type: 'TRANSFER',
      amount: valueWei,
      blockNumber,
      timestamp
    });

    activities.push({
      txHash,
      wallet: to,
      type: 'RECEIVE',
      amount: valueWei,
      blockNumber,
      timestamp
    });
  }

  // Insert transfers
  for (const t of transfers) {
    await client.query(`
      INSERT INTO token_transfers (transaction_hash, block_number, block_timestamp, from_address, to_address, value, gas_used, gas_price)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (transaction_hash) DO NOTHING
    `, [t.txHash, t.blockNumber, t.timestamp, t.from, t.to, t.value, t.gasUsed, t.gasPrice]);
  }

  // Insert activities
  for (const a of activities) {
    await client.query(`
      INSERT INTO user_activities (transaction_hash, wallet_address, activity_type, amount, block_number, block_timestamp)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (transaction_hash, wallet_address, activity_type) DO NOTHING
    `, [a.txHash, a.wallet, a.type, a.amount, a.blockNumber, a.timestamp]);
  }

  console.log(`[DB] ✔ Successfully seeded ${transfers.length} transfers and ${activities.length} activity records!`);
}

// ---------------------------------------------------------------------------
// Pool access / lifecycle
// ---------------------------------------------------------------------------

/** @returns {Pool} The underlying pg Pool instance */
function getPool() {
  return pool;
}

/** Gracefully drain all connections */
async function closePool() {
  await pool.end();
  console.log('[DB] Pool closed');
}

module.exports = {
  initializeDatabase,
  insertTokenTransfer,
  insertUserActivity,
  getLastProcessedBlock,
  setLastProcessedBlock,
  getPool,
  closePool,
};
