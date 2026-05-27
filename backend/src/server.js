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

// ── Middleware & Centralised Parsers ─────────────────────────────────────────

// Standardised CORS options
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../../dashboard')));

// Centralised Pagination Parser
function parsePagination(req, res, next) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  req.pagination = { limit, offset };
  next();
}

// ── In-Memory Cache Engine ───────────────────────────────────────────
const apiCache = {
  stats: { data: null, timestamp: 0 },
  rfm: { data: null, timestamp: 0 },
  holders: { data: null, timestamp: 0 }
};
const CACHE_TTL_MS = 5000; // 5-second TTL

function getCachedData(key) {
  const item = apiCache[key];
  if (item && Date.now() - item.timestamp < CACHE_TTL_MS) {
    return item.data;
  }
  return null;
}

function setCachedData(key, data) {
  apiCache[key] = { data, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /health
 * Quick liveness / readiness probe.
 */
app.get('/health', async (_req, res, next) => {
  try {
    const lastBlock = await getLastProcessedBlock();
    res.json({
      success: true,
      data: {
        status:    'ok',
        mode:      ingestorInfo.mode,
        uptime:    process.uptime(),
        lastBlock: lastBlock,
      },
      message: 'Health status retrieved'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /ingest
 * Manually trigger a backfill cycle.
 */
app.post('/ingest', async (_req, res, next) => {
  try {
    ingestorInfo = await startIngestor();
    res.json({
      success: true,
      data: ingestorInfo,
      message: 'Ingestion triggered successfully'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/transfers
 * Paginated list of raw token transfer events.
 */
app.get('/api/transfers', parsePagination, async (req, res, next) => {
  try {
    const { limit, offset } = req.pagination;
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
      success: true,
      data: {
        transfers: result.rows,
        count:     result.rows.length,
        limit,
        offset,
      },
      message: 'Transfers retrieved successfully'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/activities
 * Paginated list of synthesised user activities.
 */
app.get('/api/activities', parsePagination, async (req, res, next) => {
  try {
    const { limit, offset } = req.pagination;
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
      success: true,
      data: {
        activities: result.rows,
        count:      result.rows.length,
        limit,
        offset,
      },
      message: 'Activities retrieved successfully'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/stats
 * Aggregate dashboard statistics. Cached for 5s.
 */
app.get('/api/stats', async (_req, res, next) => {
  try {
    const cached = getCachedData('stats');
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        message: 'Stats retrieved from cache'
      });
    }

    const pool = getPool();
    const [transfersRes, activitiesRes, walletsRes, latestBlockRes] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS total FROM token_transfers'),
      pool.query('SELECT COUNT(*)::int AS total FROM user_activities'),
      pool.query('SELECT COUNT(DISTINCT wallet_address)::int AS total FROM user_activities'),
      pool.query('SELECT MAX(block_number)::bigint AS latest FROM token_transfers'),
    ]);

    const stats = {
      totalTransfers:  transfersRes.rows[0].total,
      totalActivities: activitiesRes.rows[0].total,
      uniqueWallets:   walletsRes.rows[0].total,
      latestBlock:     latestBlockRes.rows[0].latest ? parseInt(latestBlockRes.rows[0].latest, 10) : 0,
    };

    setCachedData('stats', stats);

    res.json({
      success: true,
      data: stats,
      message: 'Stats retrieved successfully'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/holders
 * Calculates token holder balances dynamically from all transfers. Cached for 5s.
 */
app.get('/api/holders', async (req, res, next) => {
  try {
    const cached = getCachedData('holders');
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        message: 'Holders retrieved from cache'
      });
    }

    const pool = getPool();
    const query = `
      SELECT 
        address,
        SUM(balance)::numeric AS balance
      FROM (
        SELECT to_address AS address, value AS balance FROM token_transfers
        UNION ALL
        SELECT from_address AS address, -value AS balance FROM token_transfers
      ) t
      WHERE address != '0x0000000000000000000000000000000000000000'
      GROUP BY address
      HAVING SUM(balance) > 0
      ORDER BY balance DESC
    `;
    const result = await pool.query(query);
    const holders = result.rows.map(h => ({
      address: h.address,
      balance: h.balance ? h.balance.toString() : '0'
    }));

    setCachedData('holders', holders);

    res.json({
      success: true,
      data: holders,
      message: 'Holders calculated successfully'
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/rfm
 * Dynamic RFM segmentation calculated in real-time. Cached for 5s.
 */
app.get('/api/rfm', async (_req, res, next) => {
  try {
    const cached = getCachedData('rfm');
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        message: 'RFM segmentation retrieved from cache'
      });
    }

    const pool = getPool();
    
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
      const data = { segments: {}, wallets: [] };
      setCachedData('rfm', data);
      return res.json({
        success: true,
        data,
        message: 'No activities found for RFM calculation'
      });
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

    const rfmData = {
      segments,
      wallets: computedWallets
    };

    setCachedData('rfm', rfmData);

    res.json({
      success: true,
      data: rfmData,
      message: 'RFM segmentation calculated successfully'
    });
  } catch (err) {
    next(err);
  }
});

// ── Global Error Handling Middleware ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Fatal Error Handler] ✖:', err.stack || err.message);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: status === 500 ? 'An internal server error occurred' : err.message
  });
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
