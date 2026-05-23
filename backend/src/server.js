/**
 * server.js
 * ───────────────────────────────────────────────────────────────────────────────
 * Express HTTP server for the Web3 Analytics Dashboard backend.
 *
 * Responsibilities:
 *   • Bootstrap the database schema
 *   • Launch the blockchain event ingestor
 *   • Expose REST endpoints for health checks, manual ingestion triggers,
 *     transfer/activity queries, and aggregate statistics
 *
 * Listens on port 3001 by default (override with PORT env var).
 * ───────────────────────────────────────────────────────────────────────────────
 */

// ── Global error handlers (MUST be registered before anything else) ────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('[GLOBAL] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[GLOBAL] Uncaught Exception:', error);
});

// ── Dependencies ───────────────────────────────────────────────────────────
const path    = require('path');
const express = require('express');
const cors    = require('cors');

// Load .env as early as possible so DB config is available at import time
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const {
  initializeDatabase,
  getPool,
  getLastProcessedBlock,
} = require('./db');

const { startIngestor } = require('./ingestor');
const { startTrafficGenerator } = require('./trafficGenerator');

// ── Express app ────────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3001;

// Track ingestor state so the /health endpoint can report it
let ingestorInfo = { mode: 'starting', tokenAddress: null, status: 'pending' };

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../../dashboard')));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /health
 * Quick liveness / readiness probe.
 */
app.get('/health', async (_req, res) => {
  try {
    const lastBlock = await getLastProcessedBlock();
    res.json({
      status:    'ok',
      mode:      ingestorInfo.mode,
      uptime:    process.uptime(),
      lastBlock: lastBlock,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /ingest
 * Manually trigger a backfill cycle (useful for admin / debugging).
 */
app.post('/ingest', async (_req, res) => {
  try {
    // Re-run the ingestor (it will resume from the last checkpoint)
    ingestorInfo = await startIngestor();
    res.json({ message: 'Ingestion triggered', info: ingestorInfo });
  } catch (err) {
    console.error('[Server] ✖ Manual ingestion error:', err.message);
    res.status(500).json({ message: 'Ingestion failed', error: err.message });
  }
});

/**
 * GET /api/transfers
 * Paginated list of raw token transfer events.
 * Query params: limit (default 50, max 500), offset (default 0)
 */
app.get('/api/transfers', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const offset = parseInt(req.query.offset, 10) || 0;

    const pool   = getPool();
    const result = await pool.query(
      `SELECT id, transaction_hash, block_number, block_timestamp,
              from_address, to_address, value, gas_used, gas_price, created_at
       FROM token_transfers
       ORDER BY block_number DESC, id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      transfers: result.rows,
      count:     result.rows.length,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[Server] ✖ /api/transfers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/activities
 * Paginated list of synthesised user activities.
 * Query params: limit (default 50, max 500), offset (default 0)
 */
app.get('/api/activities', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const offset = parseInt(req.query.offset, 10) || 0;

    const pool   = getPool();
    const result = await pool.query(
      `SELECT id, transaction_hash, wallet_address, activity_type,
              amount, block_number, block_timestamp, created_at
       FROM user_activities
       ORDER BY block_number DESC, id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      activities: result.rows,
      count:      result.rows.length,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[Server] ✖ /api/activities error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/stats
 * Aggregate dashboard statistics.
 */
app.get('/api/stats', async (_req, res) => {
  try {
    const pool = getPool();

    // Run all stat queries concurrently for speed
    const [transfersRes, activitiesRes, walletsRes, latestBlockRes] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS total FROM token_transfers'),
      pool.query('SELECT COUNT(*)::int AS total FROM user_activities'),
      pool.query('SELECT COUNT(DISTINCT wallet_address)::int AS total FROM user_activities'),
      pool.query('SELECT MAX(block_number)::bigint AS latest FROM token_transfers'),
    ]);

    res.json({
      totalTransfers:  transfersRes.rows[0].total,
      totalActivities: activitiesRes.rows[0].total,
      uniqueWallets:   walletsRes.rows[0].total,
      latestBlock:     latestBlockRes.rows[0].latest,
    });
  } catch (err) {
    console.error('[Server] ✖ /api/stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/rfm
 * Dynamic RFM segmentation calculated in real-time from user activities.
 */
app.get('/api/rfm', async (_req, res) => {
  try {
    const pool = getPool();
    
    // Get max block_timestamp as relative "now" so local dev dates are computed correctly
    const maxTimeRes = await pool.query('SELECT MAX(block_timestamp) as max_time FROM user_activities');
    const now = maxTimeRes.rows[0].max_time ? new Date(maxTimeRes.rows[0].max_time) : new Date();

    const query = `
      SELECT 
        wallet_address,
        MAX(block_timestamp) as last_activity,
        COUNT(*)::int as frequency,
        SUM(amount)::numeric as monetary
      FROM user_activities
      GROUP BY wallet_address
      ORDER BY frequency DESC
    `;
    const result = await pool.query(query);
    const rows = result.rows;

    if (rows.length === 0) {
      return res.json({ segments: {}, wallets: [] });
    }

    const wallets = rows.map(row => {
      const lastAct = new Date(row.last_activity);
      const recencyDays = Math.max(0, (now - lastAct) / (1000 * 60 * 60 * 24));
      return {
        wallet_address: row.wallet_address,
        last_activity: row.last_activity,
        recency_days: recencyDays,
        frequency: row.frequency,
        monetary: row.monetary ? row.monetary.toString() : '0'
      };
    });

    const sortBy = (arr, key, ascending = true) => {
      return [...arr].sort((a, b) => {
        const valA = parseFloat(a[key]);
        const valB = parseFloat(b[key]);
        return ascending ? valA - valB : valB - valA;
      });
    };

    const sortedByR = sortBy(wallets, 'recency_days', true);
    const sortedByF = sortBy(wallets, 'frequency', true);
    const sortedByM = sortBy(wallets, 'monetary', true);

    const getScore = (walletAddress, sortedArr, invert = false) => {
      const idx = sortedArr.findIndex(w => w.wallet_address === walletAddress);
      if (idx === -1) return 3;
      const pct = idx / sortedArr.length;
      let score = Math.floor(pct * 5) + 1;
      if (invert) {
        score = 6 - score;
      }
      return score;
    };

    const computedWallets = wallets.map(w => {
      const r_score = getScore(w.wallet_address, sortedByR, true);
      const f_score = getScore(w.wallet_address, sortedByF, false);
      const m_score = getScore(w.wallet_address, sortedByM, false);
      const rfm_score = r_score * 100 + f_score * 10 + m_score;

      let segment = 'Potential';
      if (r_score >= 4 && f_score >= 4) {
        segment = 'Champion';
      } else if (r_score >= 3 && f_score >= 3) {
        segment = 'Loyal';
      } else if (r_score >= 4 && f_score <= 2) {
        segment = 'New User';
      } else if (r_score <= 2 && f_score >= 3) {
        segment = 'At Risk';
      } else if (r_score <= 2 && f_score <= 2) {
        segment = 'Hibernating';
      }

      return {
        ...w,
        r_score,
        f_score,
        m_score,
        rfm_score,
        segment
      };
    });

    const segments = {
      'Champion': 0,
      'Loyal': 0,
      'New User': 0,
      'At Risk': 0,
      'Hibernating': 0,
      'Potential': 0
    };
    computedWallets.forEach(w => {
      segments[w.segment] = (segments[w.segment] || 0) + 1;
    });

    res.json({
      segments,
      wallets: computedWallets
    });

  } catch (err) {
    console.error('[Server] ✖ /api/rfm error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Startup sequence
// ---------------------------------------------------------------------------

(async () => {
  try {
    // 1. Ensure all tables / constraints exist
    console.log('[Server] Initialising database…');
    await initializeDatabase();

    // 2. Start the blockchain event ingestor
    console.log('[Server] Starting ingestor…');
    ingestorInfo = await startIngestor();
    console.log('[Server] Ingestor running:', ingestorInfo);

    // 3. Bind the HTTP server
    app.listen(PORT, () => {
      console.log(`[Server] 🚀 Web3 Analytics backend listening on http://localhost:${PORT}`);
      // Start the background traffic generator to simulate activity on Sepolia
      startTrafficGenerator();
    });
  } catch (err) {
    console.error('[Server] ✖ Fatal startup error:', err);
    process.exit(1);
  }
})();
