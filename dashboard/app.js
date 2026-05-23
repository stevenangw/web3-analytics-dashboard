/**
 * Web3 Analytics Terminal — Frontend Application Logic
 * ─────────────────────────────────────────────────────────
 * Elite, interactive trading-terminal dashboard logic.
 * Manages tabs, state, real-time RFM segment API integrations,
 * customized glowing Chart.js curves, sliding detail drawer,
 * and immediate clipboard micro-interactions.
 */

// ── Configuration ──────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://gqlgcunzwpzanfkgjlkp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdxbGdjdW56d3B6YW5ma2dqbGtwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NjgxOTUsImV4cCI6MjA5NTA0NDE5NX0.bEc9Fio5Lf4z2Y_tolbes7FW_OcsK1oclfzSjhEYsbs';

const SUPABASE_HEADERS = {
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json'
};
const PAGE_SIZE = 15;
const AUTO_REFRESH_MS = 30000; // 30 seconds

// Cached full datasets for ultra-fast offline pagination and analysis
let cachedTransfers = [];
let cachedActivities = [];
let cachedGroupedActivities = [];

// ── State ──────────────────────────────────────────────────────────────────
let state = {
  activeTab: 'overview',
  volumeTimeframe: '1m',
  gasTimeframe: '1m',
  transfers: { page: 1, data: [] },
  activities: { page: 1, data: [] },
  rfm: { data: [], segments: {} },
  holders: [],
  stats: null,
  health: null,
  charts: {
    volume: null,
    activity: null,
    cohort: null,
    gas: null
  },
  activeWallet: null,
  searchQuery: ''
};

// ── Chart.js Global Settings ───────────────────────────────────────────────
Chart.defaults.color = '#a1a1aa'; // text-secondary
Chart.defaults.borderColor = '#27272a';
Chart.defaults.font.family = "'IBM Plex Sans', sans-serif";
Chart.defaults.font.size = 11;

// ── Utilities ──────────────────────────────────────────────────────────────

/**
 * Truncate an Ethereum address or hash for display.
 */
function truncate(str, start = 6, end = 4) {
  if (!str || str.length <= start + end + 3) return str || '—';
  return `${str.slice(0, start)}…${str.slice(-end)}`;
}

/**
 * Format a large number with thousands separator.
 */
function formatNumber(num) {
  if (num === null || num === undefined || num === '—') return '—';
  return Number(num).toLocaleString('en-US');
}

/**
 * Assumes 18 decimals (standard ERC-20). Converts large integers to human-readable decimals.
 */
function formatTokenValue(value) {
  if (!value || value === '0') return '0.00';
  const str = value.toString();
  if (str.length <= 18) {
    return '0.' + str.padStart(18, '0').slice(0, 4);
  }
  const whole = str.slice(0, str.length - 18);
  const frac = str.slice(str.length - 18, str.length - 14);
  return Number(whole + '.' + frac).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/**
 * Format timestamp to a human relative or short calendar string.
 */
function formatTime(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * Copy a string to user's clipboard and trigger a toast notification.
 */
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    const toast = document.getElementById('copyToast');
    if (toast) {
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }
  }).catch(err => {
    console.error('[Clipboard] Failed to copy:', err);
  });
}

/**
 * Supabase REST Fetcher
 */
async function supabaseFetch(table, params = '') {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
      headers: SUPABASE_HEADERS
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.warn(`[Supabase REST] Failed to fetch from ${table}:`, err.message);
    return [];
  }
}

// ── Data Ingestion & Sync ──────────────────────────────────────────────────

async function triggerManualIngestion() {
  const btn = document.getElementById('triggerIngestBtn');
  btn.disabled = true;
  btn.classList.add('syncing');
  btn.querySelector('span').textContent = 'Syncing...';

  try {
    // Attempt local ingest trigger if on localhost, otherwise notify that ingest runs on the local node
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    if (isLocal) {
      const res = await fetch('http://localhost:3001/ingest', { method: 'POST' });
      const data = await res.json();
      console.log('[Ingestor] Manual ingestion complete:', data);
    } else {
      alert("In production, the Ingestor runs automatically from your local terminal whenever 'npm start' is active.");
    }
    
    await refreshAll();
  } catch (err) {
    console.error('[Ingestor] Ingestion trigger failed:', err);
    alert("Could not connect to the local ingestor node. Make sure it is running on your machine!");
  } finally {
    btn.disabled = false;
    btn.classList.remove('syncing');
    btn.querySelector('span').textContent = 'Trigger Ingest';
  }
}

// ── Client-Side RFM Segmentation Engine ─────────────────────────────────────

function calculateRFM(activities) {
  if (!activities || activities.length === 0) {
    return { wallets: [], segments: {} };
  }

  // 1. Group by wallet_address
  const groups = {};
  let maxTime = new Date(0);

  activities.forEach(a => {
    const wallet = a.wallet_address;
    const time = new Date(a.block_timestamp);
    if (time > maxTime) maxTime = time;

    if (!groups[wallet]) {
      groups[wallet] = {
        wallet_address: wallet,
        last_activity: time,
        frequency: 0,
        monetary: BigInt(0)
      };
    }

    groups[wallet].frequency += 1;
    if (time > groups[wallet].last_activity) {
      groups[wallet].last_activity = time;
    }
    
    // Clean and accumulate amount (NUMERIC safe)
    let valStr = (a.amount || '0').toString().split('.')[0]; // Integer portion for BigInt
    try {
      groups[wallet].monetary += BigInt(valStr);
    } catch {
      // Non-critical parsing fallback
    }
  });

  const now = maxTime;

  // 2. Convert to array and calculate recency in days
  const wallets = Object.values(groups).map(g => {
    const recencyDays = Math.max(0, (now - g.last_activity) / (1000 * 60 * 60 * 24));
    return {
      wallet_address: g.wallet_address,
      last_activity: g.last_activity.toISOString(),
      recency_days: recencyDays,
      frequency: g.frequency,
      monetary: g.monetary.toString()
    };
  });

  // 3. Score R, F, M (1 to 5)
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

  return {
    wallets: computedWallets,
    segments
  };
}

/**
 * Helper to group raw activities by transaction hash to combine sender and receiver.
 */
function groupActivities(activities) {
  if (!activities || activities.length === 0) return [];
  const map = new Map();

  activities.forEach(a => {
    const tx = a.transaction_hash;
    if (!map.has(tx)) {
      const txDetails = cachedTransfers.find(t => t.transaction_hash === tx);
      map.set(tx, {
        transaction_hash: tx,
        block_number: a.block_number,
        block_timestamp: a.block_timestamp,
        amount: a.amount,
        sender: txDetails ? txDetails.from_address : null,
        receiver: txDetails ? txDetails.to_address : null
      });
    }
    const entry = map.get(tx);
    if (a.activity_type === 'TRANSFER') {
      entry.sender = a.wallet_address;
    } else if (a.activity_type === 'RECEIVE') {
      entry.receiver = a.wallet_address;
    }
  });

  return Array.from(map.values());
}

/**
 * Helper to get the relative "now" timestamp from the latest block to support offline simulation correctly.
 */
function getNow() {
  if (cachedTransfers.length === 0) return new Date();
  return new Date(Math.max(...cachedTransfers.map(t => new Date(t.block_timestamp))));
}

/**
 * Filter transfers based on the selected timeframe.
 */
function getFilteredTransfers(tf = '1m') {
  if (cachedTransfers.length === 0) return [];
  const now = getNow();

  let msLimit = 30 * 24 * 60 * 60 * 1000; // default 30 days
  if (tf === '1h') msLimit = 1 * 60 * 60 * 1000;
  else if (tf === '4h') msLimit = 4 * 60 * 60 * 1000;
  else if (tf === '1d') msLimit = 24 * 60 * 60 * 1000;
  else if (tf === '1w') msLimit = 7 * 24 * 60 * 60 * 1000;

  return cachedTransfers.filter(t => (now - new Date(t.block_timestamp)) <= msLimit);
}

/**
 * Helper to group timestamps dynamically based on the active timeframe.
 */
function getGroupKey(dateObj, tf) {
  if (tf === '1h' || tf === '4h') {
    const hours = dateObj.getHours().toString().padStart(2, '0');
    const minutes = (Math.floor(dateObj.getMinutes() / 5) * 5).toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  } else if (tf === '1d') {
    const hours = dateObj.getHours().toString().padStart(2, '0');
    return `${hours}:00`;
  } else {
    return dateObj.toISOString().split('T')[0];
  }
}

/**
 * Compute real-time token balances from the transfer ledger for all wallets.
 */
function calculateHolders() {
  const balances = {};
  
  cachedTransfers.forEach(t => {
    const from = t.from_address;
    const to = t.to_address;
    const val = BigInt(t.value || '0');

    if (from !== '0x0000000000000000000000000000000000000000') {
      balances[from] = (balances[from] || BigInt(0)) - val;
    }
    balances[to] = (balances[to] || BigInt(0)) + val;
  });

  // Convert to array and filter out empty/dust wallets
  const holders = Object.keys(balances).map(addr => ({
    address: addr,
    balance: balances[addr]
  }))
  .filter(h => h.balance > BigInt(0))
  .sort((a, b) => (b.balance > a.balance ? 1 : -1));

  state.holders = holders;
  return holders;
}

/**
 * Render Top Holders / Whale Concentration Table
 */
function renderWhalesTable() {
  const tbody = document.getElementById('whalesTableBody');
  const countLabel = document.getElementById('whaleHoldersCountText');
  const holders = state.holders || [];

  if (!tbody) return;
  countLabel.textContent = `${formatNumber(holders.length)} wallets`;

  if (holders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state-cell">No active whale profiles.</td></tr>';
    return;
  }

  // Calculate total supply to show share percentage
  const totalSupply = holders.reduce((acc, h) => acc + h.balance, BigInt(0));

  tbody.innerHTML = holders.slice(0, 15).map((h, index) => {
    const share = totalSupply > BigInt(0) ? (Number(h.balance * BigInt(10000) / totalSupply) / 100) : 0;
    return `
      <tr>
        <td class="mono font-600 align-center" style="color: ${index < 3 ? 'var(--accent)' : 'var(--muted)'}">#${index + 1}</td>
        <td>
          <span class="address-pill" onclick="openWalletDrawer('${h.address}')" title="Click to inspect Wallet">
            ${truncate(h.address, 5, 4)}
          </span>
        </td>
        <td class="align-right mono font-600 text-title">${parseFloat(formatTokenValue(h.balance)).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
        <td class="align-right mono text-title" style="color: var(--accent); font-weight: 500;">${share.toFixed(2)}%</td>
      </tr>
    `;
  }).join('');
}

// ── Direct Supabase Mock Status Fetchers ────────────────────────────────────

async function fetchHealth() {
  state.health = {
    status: 'ok',
    mode: 'hybrid',
    uptime: performance.now() / 1000
  };
  renderStatus();
}

// Core fetchers are now unified directly in refreshAll using Supabase REST.

// ── UI Rendering Elements ──────────────────────────────────────────────────

function renderKPIs() {
  const s = state.stats;
  if (!s) return;

  document.getElementById('totalTransfers').textContent = formatNumber(s.totalTransfers);
  document.getElementById('totalActivities').textContent = formatNumber(s.totalActivities);
  document.getElementById('uniqueWallets').textContent = formatNumber(s.uniqueWallets);
  document.getElementById('latestBlock').textContent = s.latestBlock ? `#${formatNumber(s.latestBlock)}` : '—';
  document.getElementById('latestBlockValue').textContent = s.latestBlock ? `#${formatNumber(s.latestBlock)}` : '#—';

  document.querySelectorAll('.kpi-value').forEach(el => el.classList.remove('loading'));
}

function renderStatus() {
  const h = state.health;
  const pulse = document.getElementById('sidebarPulse');
  const text = document.getElementById('syncStatusText');
  const badge = document.getElementById('modeBadge');

  if (h && h.status === 'ok') {
    pulse.classList.remove('offline');
    pulse.classList.add('anim-pulse');
    text.textContent = `Synced Node — ${Math.floor(h.uptime)}s`;

    if (h.mode === 'hybrid') {
      badge.textContent = '🌐 Sepolia';
      badge.className = 'badge badge-live';
    } else if (h.mode === 'local') {
      badge.textContent = '🏠 Local Node';
      badge.className = 'badge badge-local';
    } else {
      badge.textContent = h.mode;
      badge.className = 'badge';
    }
  }
}

function renderOffline() {
  const pulse = document.getElementById('sidebarPulse');
  const text = document.getElementById('syncStatusText');
  const badge = document.getElementById('modeBadge');

  pulse.classList.add('offline');
  pulse.classList.remove('anim-pulse');
  text.textContent = 'Node RPC offline';
  badge.textContent = 'Disconnected';
  badge.className = 'badge';
}

function renderTransfersTable(filteredData = null) {
  const tbody = document.getElementById('transfersBody');
  const pageInfo = document.getElementById('transfersPageInfo');
  const data = filteredData || state.transfers.data;

  document.getElementById('transfersCountText').textContent = `${formatNumber(data.length)} events loaded`;

  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state-cell">No matching transfer events found.</td></tr>';
    pageInfo.textContent = `Page ${state.transfers.page}`;
    return;
  }

  tbody.innerHTML = data.map(t => `
    <tr>
      <td>
        <span class="tx-hash-link" onclick="copyToClipboard('${t.transaction_hash}')" title="Click to copy Transaction Hash">
          ${truncate(t.transaction_hash, 12, 8)}
        </span>
      </td>
      <td class="mono font-500">${formatNumber(t.block_number)}</td>
      <td>
        <span class="address-pill" onclick="openWalletDrawer('${t.from_address}')" title="Click to inspect Wallet">
          ${truncate(t.from_address)}
        </span>
      </td>
      <td>
        <span class="address-pill" onclick="openWalletDrawer('${t.to_address}')" title="Click to inspect Wallet">
          ${truncate(t.to_address)}
        </span>
      </td>
      <td class="align-right mono font-600 text-title">${formatTokenValue(t.value)}</td>
      <td class="align-right text-muted">${formatTime(t.block_timestamp)}</td>
    </tr>
  `).join('');

  pageInfo.textContent = `Page ${state.transfers.page}`;
}

function renderActivitiesTable(filteredData = null) {
  const tbody = document.getElementById('activitiesBody');
  const pageInfo = document.getElementById('activitiesPageInfo');
  const data = filteredData || state.activities.data;

  document.getElementById('activitiesCountText').textContent = `${formatNumber(data.length)} items synthesized`;

  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state-cell">No matching synthesized activity items.</td></tr>';
    pageInfo.textContent = `Page ${state.activities.page}`;
    return;
  }

  tbody.innerHTML = data.map(a => `
    <tr>
      <td>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="address-pill" onclick="openWalletDrawer('${a.sender || '—'}')" title="Click to inspect Sender Wallet">
            ${truncate(a.sender)}
          </span>
          <span style="color: var(--muted); font-size: 11px;">➔</span>
          <span class="address-pill" onclick="openWalletDrawer('${a.receiver || '—'}')" title="Click to inspect Receiver Wallet">
            ${truncate(a.receiver)}
          </span>
        </div>
      </td>
      <td>
        <span class="badge-action-type transfer">TRANSFER</span>
      </td>
      <td class="align-right mono font-600 text-title">${formatTokenValue(a.amount)}</td>
      <td class="mono">${formatNumber(a.block_number)}</td>
      <td>
        <span class="tx-hash-link" onclick="copyToClipboard('${a.transaction_hash}')" title="Copy Hash">
          ${truncate(a.transaction_hash, 8, 4)}
        </span>
      </td>
      <td class="align-right text-muted">${formatTime(a.block_timestamp)}</td>
    </tr>
  `).join('');

  pageInfo.textContent = `Page ${state.activities.page}`;
}

function renderLiveFeed(transfers) {
  const container = document.getElementById('overviewFeedList');
  if (!transfers || transfers.length === 0) {
    container.innerHTML = '<div class="feed-placeholder">Awaiting block event telemetry...</div>';
    return;
  }

  // Display top 6 transfers as dynamic live feed items
  const feedItems = transfers.slice(0, 6);
  container.innerHTML = feedItems.map(t => {
    const val = parseFloat(t.value) / 1e18;
    return `
      <div class="feed-item">
        <div class="feed-item-left">
          <span class="feed-pill transfer">TX</span>
          <span class="feed-desc">
            <span class="address" onclick="openWalletDrawer('${t.from_address}')">${truncate(t.from_address, 5, 4)}</span>
            transfered to
            <span class="address" onclick="openWalletDrawer('${t.to_address}')">${truncate(t.to_address, 5, 4)}</span>
          </span>
        </div>
        <div class="feed-item-right align-right">
          <span class="feed-val">${val.toFixed(2)} tokens</span>
          <span class="feed-time">${formatTime(t.block_timestamp)}</span>
        </div>
      </div>
    `;
  }).join('');
}

// ── RFM View Rendering ─────────────────────────────────────────────────────

function renderRFMView(filteredData = null) {
  const tbody = document.getElementById('rfmTableBody');
  const countLabel = document.getElementById('rfmTotalWalletsText');
  const data = filteredData || state.rfm.data;

  countLabel.textContent = `${formatNumber(data.length)} profiles listed`;

  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state-cell">No matching classified profiles.</td></tr>';
    renderRFMStatSummaries();
    renderRFMCohortChart();
    return;
  }

  tbody.innerHTML = data.map(w => `
    <tr>
      <td>
        <span class="address-pill" onclick="openWalletDrawer('${w.wallet_address}')" title="Inspect profile">
          ${w.wallet_address}
        </span>
      </td>
      <td>
        <span class="rfm-tag ${w.segment.toLowerCase().replace(' ', '-')}">${w.segment}</span>
      </td>
      <td class="align-right mono font-500">${w.recency_days.toFixed(1)}d ago</td>
      <td class="align-right mono text-title">${formatNumber(w.frequency)}</td>
      <td class="align-right mono text-title font-600">${parseFloat(formatTokenValue(w.monetary)).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
      <td class="align-right mono font-600 text-title" style="color: var(--accent-cyan)">${w.rfm_score}</td>
      <td class="align-center">
        <button class="inspect-btn" onclick="openWalletDrawer('${w.wallet_address}')">Inspect</button>
      </td>
    </tr>
  `).join('');

  // Render side list summaries (Overview of percentages)
  renderRFMStatSummaries();

  // Render or update RFM cohort chart
  renderRFMCohortChart();
}

function renderRFMStatSummaries() {
  const container = document.getElementById('segmentStatsSummaryList');
  if (!state.rfm.data || state.rfm.data.length === 0) {
    container.innerHTML = '<div class="segment-stat-placeholder">No active cohorts detected.</div>';
    return;
  }

  const total = state.rfm.data.length;
  const segments = state.rfm.segments;

  const segmentMetas = [
    { name: 'Champion', class: 'champion', desc: 'Highly active and high monetary values' },
    { name: 'Loyal', class: 'loyal', desc: 'Consistent transactions over time' },
    { name: 'New User', class: 'new-user', desc: 'First transaction logged recently' },
    { name: 'Potential', class: 'potential', desc: 'Moderate frequency & recency profiles' },
    { name: 'At Risk', class: 'at-risk', desc: 'No transaction recorded recently' },
    { name: 'Hibernating', class: 'hibernating', desc: 'Inactive for a prolonged duration' }
  ];

  container.innerHTML = segmentMetas.map(seg => {
    const count = segments[seg.name] || 0;
    const percentage = total > 0 ? (count / total) * 100 : 0;
    return `
      <div class="segment-stat-item" title="${seg.desc}">
        <div class="segment-stat-meta">
          <span class="segment-stat-title">${seg.name}s</span>
          <span class="segment-stat-val">${count} (${percentage.toFixed(1)}%)</span>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill ${seg.class}" style="width: ${percentage}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ── Slide-Out Wallet Drawer ────────────────────────────────────────────────

function openWalletDrawer(address) {
  state.activeWallet = address;

  // Set wallet address text
  document.getElementById('drawerWalletAddress').textContent = address;

  // Aggregate stats from existing tables/data to display in drawer
  // 1. RFM status
  const profile = state.rfm.data.find(w => w.wallet_address.toLowerCase() === address.toLowerCase());
  const segmentTag = document.getElementById('drawerCohortTag');
  const codeTag = document.getElementById('drawerRfmCode');
  
  if (profile) {
    segmentTag.className = `rfm-tag ${profile.segment.toLowerCase().replace(' ', '-')}`;
    segmentTag.textContent = profile.segment;
    segmentTag.style.display = 'inline-block';
    codeTag.textContent = profile.rfm_score;
  } else {
    segmentTag.style.display = 'none';
    codeTag.textContent = 'N/A';
  }

  // 2. Aggregate transaction history specifically for this address
  // Query all local active datasets to construct detailed ledger history
  const transfersInvolvingWallet = state.transfers.data.filter(
    t => t.from_address.toLowerCase() === address.toLowerCase() || 
         t.to_address.toLowerCase() === address.toLowerCase()
  );

  const freqVal = document.getElementById('drawerFreqVal');
  const monetaryVal = document.getElementById('drawerMonetaryVal');
  const recencyVal = document.getElementById('drawerRecencyVal');

  freqVal.textContent = profile ? profile.frequency : transfersInvolvingWallet.length;
  monetaryVal.textContent = profile ? parseFloat(formatTokenValue(profile.monetary)).toLocaleString('en-US', {minimumFractionDigits: 2}) : '0.00';
  recencyVal.textContent = profile ? `${profile.recency_days.toFixed(1)} days ago` : 'N/A';

  // Render History logs in drawer
  const historyContainer = document.getElementById('drawerHistoryList');
  if (transfersInvolvingWallet.length === 0) {
    historyContainer.innerHTML = '<div class="history-item-placeholder">No recent transaction logs cached on current page.</div>';
  } else {
    historyContainer.innerHTML = transfersInvolvingWallet.map(t => {
      const isSender = t.from_address.toLowerCase() === address.toLowerCase();
      const val = parseFloat(t.value) / 1e18;
      const typeLabel = isSender ? 'TRANSFER SENT' : 'TRANSFER RECEIVED';
      const amtClass = isSender ? 'negative' : 'positive';
      const prefix = isSender ? '-' : '+';
      const counterparty = isSender ? t.to_address : t.from_address;

      return `
        <div class="history-item">
          <div class="history-item-top">
            <span class="history-action-label">${typeLabel}</span>
            <span class="history-amount ${amtClass}">${prefix}${val.toFixed(2)} tokens</span>
          </div>
          <div class="history-item-bottom">
            <span>Counterparty: <span class="history-counterparty">${truncate(counterparty, 6, 4)}</span></span>
            <span>Block <span class="mono">${t.block_number}</span></span>
          </div>
          <div class="history-item-bottom">
            <span>Tx: <span class="history-tx">${truncate(t.transaction_hash, 10, 6)}</span></span>
            <span>${formatTime(t.block_timestamp)}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // Bind Drawer Copy Button action
  document.getElementById('drawerCopyBtn').onclick = () => copyToClipboard(address);

  // Open Drawer and Overlay
  document.getElementById('walletDrawer').classList.add('open');
  document.getElementById('drawerOverlay').classList.add('active');
}

function closeWalletDrawer() {
  document.getElementById('walletDrawer').classList.remove('open');
  document.getElementById('drawerOverlay').classList.remove('active');
  state.activeWallet = null;
}

// ── Chart.js Builders ──────────────────────────────────────────────────────

function renderVolumeChart() {
  const tf = state.volumeTimeframe || '1m';
  const transfers = getFilteredTransfers(tf);

  // Aggregate transfers dynamically
  const dailyVolume = {};
  const dailyCount = {};

  transfers.forEach(t => {
    const dateObj = new Date(t.block_timestamp);
    const key = getGroupKey(dateObj, tf);
    if (!dailyVolume[key]) {
      dailyVolume[key] = 0;
      dailyCount[key] = 0;
    }
    const val = parseFloat(t.value) / 1e18;
    dailyVolume[key] += val;
    dailyCount[key] += 1;
  });

  const labels = Object.keys(dailyVolume).sort();
  const volumeData = labels.map(d => dailyVolume[d]);
  const countData = labels.map(d => dailyCount[d]);

  if (state.charts.volume) {
    state.charts.volume.destroy();
  }

  const canvas = document.getElementById('volumeChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Format labels nicely on the X axis
  const formattedLabels = labels.map(label => {
    if (tf === '1h' || tf === '4h' || tf === '1d') {
      return label; // already formatted as HH:MM or HH:00
    }
    return new Date(label).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  state.charts.volume = new Chart(ctx, {
    type: 'line',
    data: {
      labels: formattedLabels,
      datasets: [
        {
          label: 'Volume',
          data: volumeData,
          borderColor: '#2dd4bf', // Accent Teal
          borderWidth: 1.5,
          fill: false,
          tension: 0.2,
          pointRadius: 2,
          pointHoverRadius: 4,
          yAxisID: 'y'
        },
        {
          label: 'Transfers',
          data: countData,
          borderColor: '#fafafa', // Monochrome White
          borderWidth: 1.5,
          fill: false,
          tension: 0.2,
          pointRadius: 2,
          pointHoverRadius: 4,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: {
            usePointStyle: true,
            boxWidth: 5,
            padding: 15
          }
        },
        tooltip: {
          backgroundColor: '#131316',
          borderColor: '#27272a',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 0,
          titleFont: { weight: '600', family: "'IBM Plex Sans', sans-serif" },
          bodyFont: { family: "'JetBrains Mono', monospace" }
        }
      },
      scales: {
        x: {
          grid: { color: '#27272a' },
          ticks: { maxTicksLimit: 10 }
        },
        y: {
          position: 'left',
          grid: { color: '#27272a' },
          ticks: {
            callback: val => val.toLocaleString()
          }
        },
        y1: {
          position: 'right',
          grid: { display: false },
          ticks: {
            callback: val => val.toFixed(0)
          }
        }
      }
    }
  });
}

function renderActivityChart(activities) {
  const typeCounts = {};
  activities.forEach(a => {
    const type = a.activity_type;
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });

  const labels = Object.keys(typeCounts);
  const data = Object.values(typeCounts);
  
  const colors = labels.map(l => {
    if (l === 'TRANSFER') return '#ef4444'; // rose
    if (l === 'RECEIVE') return '#10b981'; // emerald
    return '#8b5cf6';
  });

  const borderColors = labels.map(l => {
    if (l === 'TRANSFER') return 'rgba(239, 68, 68, 0.15)';
    if (l === 'RECEIVE') return 'rgba(16, 185, 129, 0.15)';
    return 'rgba(139, 92, 246, 0.15)';
  });

  if (state.charts.activity) {
    state.charts.activity.destroy();
  }

  const canvas = document.getElementById('activityChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  state.charts.activity = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: colors,
          borderColor: borderColors,
          borderWidth: 2,
          hoverOffset: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            usePointStyle: true,
            boxWidth: 6,
            padding: 12
          }
        },
        tooltip: {
          backgroundColor: 'rgba(9, 9, 11, 0.95)',
          borderColor: 'rgba(255, 255, 255, 0.08)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 6
        }
      }
    }
  });
}

function renderRFMCohortChart() {
  const segments = state.rfm.segments;
  if (!segments || Object.keys(segments).length === 0) return;

  const labels = Object.keys(segments);
  const data = Object.values(segments);

  const colors = labels.map(label => {
    if (label === 'Champion') return '#2dd4bf';     // Teal
    if (label === 'Loyal') return '#22c55e';        // Green
    if (label === 'New User') return '#f59e0b';     // Amber
    if (label === 'Potential') return '#fafafa';    // White
    if (label === 'At Risk') return '#f43f5e';      // Red
    return '#52525b';                               // Gray
  });

  if (state.charts.cohort) {
    state.charts.cohort.destroy();
  }

  const canvas = document.getElementById('rfmCohortChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  state.charts.cohort = new Chart(ctx, {
    type: 'polarArea',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors.map(c => c + '15'), // very subtle opacity
        borderColor: colors,
        borderWidth: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        r: {
          grid: { color: '#27272a' },
          angleLines: { color: '#27272a' },
          ticks: {
            backdropColor: 'transparent',
            color: '#8e8e93'
          }
        }
      },
      plugins: {
        legend: {
          position: 'right',
          labels: {
            usePointStyle: true,
            boxWidth: 6,
            padding: 10
          }
        },
        tooltip: {
          backgroundColor: '#131316',
          borderColor: '#27272a',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 0
        }
      }
    }
  });
}

/**
 * Render Gas Cost Analytics Chart and update KPI metrics
 */
function renderGasChart() {
  const tf = state.gasTimeframe || '1m';
  const transfers = getFilteredTransfers(tf);

  const dailyGasUsed = {};
  const dailyGasPrice = {};
  const dailyCount = {};

  transfers.forEach(t => {
    const dateObj = new Date(t.block_timestamp);
    const key = getGroupKey(dateObj, tf);
    if (!dailyGasUsed[key]) {
      dailyGasUsed[key] = 0;
      dailyGasPrice[key] = 0;
      dailyCount[key] = 0;
    }
    const gasUsed = parseInt(t.gas_used || '0');
    const gasPrice = parseFloat(t.gas_price || '0') / 1e9; // Convert to Gwei
    dailyGasUsed[key] += gasUsed;
    dailyGasPrice[key] += gasPrice;
    dailyCount[key] += 1;
  });

  const labels = Object.keys(dailyGasUsed).sort();
  const gasUsedData = labels.map(d => dailyGasUsed[d]);
  const avgGasPriceData = labels.map(d => dailyCount[d] > 0 ? (dailyGasPrice[d] / dailyCount[d]) : 0);

  if (state.charts.gas) {
    state.charts.gas.destroy();
  }

  const canvas = document.getElementById('gasChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const formattedLabels = labels.map(label => {
    if (tf === '1h' || tf === '4h' || tf === '1d') {
      return label; // already formatted
    }
    return new Date(label).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  state.charts.gas = new Chart(ctx, {
    type: 'line',
    data: {
      labels: formattedLabels,
      datasets: [
        {
          label: 'Gas Used',
          data: gasUsedData,
          borderColor: '#f59e0b',
          borderWidth: 1.5,
          fill: false,
          tension: 0.2,
          pointRadius: 2,
          pointHoverRadius: 4,
          yAxisID: 'y'
        },
        {
          label: 'Avg Gas Price (Gwei)',
          data: avgGasPriceData,
          borderColor: '#fafafa',
          borderWidth: 1.5,
          fill: false,
          tension: 0.2,
          pointRadius: 2,
          pointHoverRadius: 4,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: {
            usePointStyle: true,
            boxWidth: 5,
            padding: 15
          }
        },
        tooltip: {
          backgroundColor: '#131316',
          borderColor: '#27272a',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 0,
          titleFont: { weight: '600', family: "'IBM Plex Sans', sans-serif" },
          bodyFont: { family: "'JetBrains Mono', monospace" }
        }
      },
      scales: {
        x: {
          grid: { color: '#27272a' },
          ticks: { maxTicksLimit: 10 }
        },
        y: {
          position: 'left',
          grid: { color: '#27272a' },
          ticks: {
            callback: val => val.toLocaleString()
          }
        },
        y1: {
          position: 'right',
          grid: { display: false },
          ticks: {
            callback: val => val.toFixed(1) + ' Gwei'
          }
        }
      }
    }
  });

  // Calculate totals for KPI fields using active timeframe transfers
  let totalGas = 0;
  let totalPriceSum = 0;
  let txCount = 0;
  transfers.forEach(t => {
    totalGas += parseInt(t.gas_used || '0');
    totalPriceSum += parseFloat(t.gas_price || '0');
    if (t.gas_price) txCount++;
  });
  const avgGasPriceGwei = txCount > 0 ? (totalPriceSum / txCount / 1e9) : 0;

  document.getElementById('avgGasPriceVal').textContent = `${avgGasPriceGwei.toFixed(2)} Gwei`;
  document.getElementById('totalGasUsedVal').textContent = totalGas.toLocaleString();
}

/**
 * Universal Data Export to CSV/JSON format
 */
function exportData(type, format) {
  let dataToExport = [];
  let filename = '';

  if (type === 'transfers') {
    dataToExport = cachedTransfers;
    filename = 'transfers_ledger';
  } else if (type === 'activities') {
    dataToExport = cachedGroupedActivities;
    filename = 'wallet_activities';
  } else if (type === 'rfm') {
    dataToExport = state.rfm.data;
    filename = 'rfm_profiles';
  } else if (type === 'whales') {
    dataToExport = state.holders.map((h, i) => ({
      rank: i + 1,
      address: h.address,
      balance: h.balance.toString()
    }));
    filename = 'top_token_holders';
  }

  if (dataToExport.length === 0) {
    alert('No data available to export.');
    return;
  }

  let content = '';
  let mimeType = '';

  if (format === 'json') {
    content = JSON.stringify(dataToExport, null, 2);
    mimeType = 'application/json';
    filename += '.json';
  } else if (format === 'csv') {
    const headers = Object.keys(dataToExport[0]);
    const csvRows = [headers.join(',')];

    dataToExport.forEach(row => {
      const values = headers.map(header => {
        const val = row[header];
        const escaped = ('' + (val !== null && val !== undefined ? val : '')).replace(/"/g, '\\"');
        return `"${escaped}"`;
      });
      csvRows.push(values.join(','));
    });

    content = csvRows.join('\n');
    mimeType = 'text/csv';
    filename += '.csv';
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Pagination and Pagination Handlers ─────────────────────────────────────

function changePage(table, delta) {
  if (table === 'transfers') {
    const newPage = state.transfers.page + delta;
    if (newPage < 1) return;
    const offset = (newPage - 1) * PAGE_SIZE;
    if (offset >= cachedTransfers.length) return;
    state.transfers.page = newPage;
    state.transfers.data = cachedTransfers.slice(offset, offset + PAGE_SIZE);
    renderTransfersTable();
  } else if (table === 'activities') {
    const newPage = state.activities.page + delta;
    if (newPage < 1) return;
    const offset = (newPage - 1) * PAGE_SIZE;
    if (offset >= cachedGroupedActivities.length) return;
    state.activities.page = newPage;
    state.activities.data = cachedGroupedActivities.slice(offset, offset + PAGE_SIZE);
    renderActivitiesTable();
  }
}

// ── Sidebar Switch Action Handlers ─────────────────────────────────────────

function bindSidebarNavigation() {
  const menuButtons = document.querySelectorAll('.menu-item');
  const panels = document.querySelectorAll('.tab-panel');

  menuButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      // Deactivate current
      menuButtons.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      // Activate clicked
      btn.classList.add('active');
      const targetTab = btn.getAttribute('data-tab');
      state.activeTab = targetTab;

      const activePanel = document.getElementById(`tab-${targetTab}`);
      if (activePanel) {
        activePanel.classList.add('active');
      }

      // Update Header Title
      const titles = {
        'overview': 'Dashboard Overview',
        'transfers': 'Token Transfers Ledger',
        'activities': 'Synthesized Wallet Activities',
        'rfm': 'RFM Segmentation Cohorts'
      };
      document.getElementById('currentViewTitle').textContent = titles[targetTab] || 'Web3 Analytics';

      // Lazy load chart rendering or listings
      if (targetTab === 'overview') {
        if (cachedTransfers.length > 0) {
          renderVolumeChart(cachedTransfers.slice(0, 150));
          renderGasChart(cachedTransfers.slice(0, 150));
          renderLiveFeed(cachedTransfers);
        }
        if (cachedActivities.length > 0) {
          renderActivityChart(cachedActivities.slice(0, 150));
        }
      } else if (targetTab === 'rfm') {
        renderRFMCohortChart();
      }
    });
  });
}

// ── Search filters ─────────────────────────────────────────────────────────

function applyTransfersFilters() {
  const q = (document.getElementById('transfersLocalSearch')?.value || '').toLowerCase();
  const minVal = parseFloat(document.getElementById('transfersMinValFilter')?.value || '0');

  let filtered = cachedTransfers;

  if (q) {
    filtered = filtered.filter(
      t => t.transaction_hash.toLowerCase().includes(q) || 
           t.from_address.toLowerCase().includes(q) || 
           t.to_address.toLowerCase().includes(q)
    );
  }

  if (minVal > 0) {
    filtered = filtered.filter(t => {
      const val = parseFloat(t.value) / 1e18;
      return val >= minVal;
    });
  }

  renderTransfersTable(filtered.slice(0, 100));
}

function applyActivitiesFilters() {
  const q = (document.getElementById('activitiesLocalSearch')?.value || '').toLowerCase();
  const minAmt = parseFloat(document.getElementById('activitiesMinAmtFilter')?.value || '0');

  let filtered = cachedGroupedActivities;

  if (q) {
    filtered = filtered.filter(
      a => (a.sender && a.sender.toLowerCase().includes(q)) || 
           (a.receiver && a.receiver.toLowerCase().includes(q)) ||
           a.transaction_hash.toLowerCase().includes(q)
    );
  }

  if (minAmt > 0) {
    filtered = filtered.filter(a => {
      const val = parseFloat(a.amount) / 1e18;
      return val >= minAmt;
    });
  }

  renderActivitiesTable(filtered.slice(0, 100));
}

function bindTableSearchFilters() {
  // Transfers Local filter & Min Val Filter
  const transfersSearch = document.getElementById('transfersLocalSearch');
  const transfersMinVal = document.getElementById('transfersMinValFilter');
  if (transfersSearch) transfersSearch.addEventListener('input', applyTransfersFilters);
  if (transfersMinVal) transfersMinVal.addEventListener('input', applyTransfersFilters);

  // Activities Local filter & Min Amt Filter
  const activitiesSearch = document.getElementById('activitiesLocalSearch');
  const activitiesMinAmt = document.getElementById('activitiesMinAmtFilter');
  if (activitiesSearch) activitiesSearch.addEventListener('input', applyActivitiesFilters);
  if (activitiesMinAmt) activitiesMinAmt.addEventListener('input', applyActivitiesFilters);

  // RFM Database local search
  const rfmSearch = document.getElementById('rfmTableSearch');
  if (rfmSearch) {
    rfmSearch.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      if (!q) {
        renderRFMView();
        return;
      }
      const filtered = state.rfm.data.filter(
        w => w.wallet_address.toLowerCase().includes(q) || 
             w.segment.toLowerCase().includes(q) ||
             w.rfm_score.toString().includes(q)
      );
      renderRFMView(filtered);
    });
  }

  // Global search input
  const globalSearch = document.getElementById('globalSearchInput');
  const clearBtn = document.getElementById('searchClearBtn');
  
  if (globalSearch) {
    globalSearch.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      clearBtn.style.display = val ? 'block' : 'none';

      // Dynamic check for full EVM address
      if (val.length === 42 && val.startsWith('0x')) {
        openWalletDrawer(val);
      }
    });

    globalSearch.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const val = globalSearch.value.trim();
        if (val) {
          // Open drawer on matching address
          openWalletDrawer(val);
        }
      }
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      globalSearch.value = '';
      clearBtn.style.display = 'none';
    });
  }
}

// ── Refresh All ────────────────────────────────────────────────────────────

async function refreshAll() {
  const btn = document.getElementById('refreshBtn');
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.6';
  }

  // 1. Fetch raw datasets directly from Supabase Cloud
  cachedTransfers = await supabaseFetch('token_transfers', '?select=*&order=block_number.desc,id.desc&limit=1000');
  cachedActivities = await supabaseFetch('user_activities', '?select=*&order=block_number.desc,id.desc&limit=1000');

  // 2. Fetch Health state
  await fetchHealth();

  // 3. Compute stats and render KPIs
  const totalTransfers = cachedTransfers.length;
  const totalActivities = cachedActivities.length;
  const uniqueWallets = new Set(cachedActivities.map(a => a.wallet_address)).size;
  const latestBlock = cachedTransfers.length > 0 ? Math.max(...cachedTransfers.map(t => parseInt(t.block_number))) : 0;

  state.stats = {
    totalTransfers,
    totalActivities,
    uniqueWallets,
    latestBlock
  };
  renderKPIs();

  // 4. Render transfers page
  const transfersPage = state.transfers.page;
  const transfersOffset = (transfersPage - 1) * PAGE_SIZE;
  state.transfers.data = cachedTransfers.slice(transfersOffset, transfersOffset + PAGE_SIZE);
  renderTransfersTable();
  
  if (state.activeTab === 'overview') {
    renderLiveFeed(cachedTransfers);
  }

  // Group activities to avoid duplicate rows for the same transaction
  cachedGroupedActivities = groupActivities(cachedActivities);

  // 5. Render activities page
  const activitiesPage = state.activities.page;
  const activitiesOffset = (activitiesPage - 1) * PAGE_SIZE;
  state.activities.data = cachedGroupedActivities.slice(activitiesOffset, activitiesOffset + PAGE_SIZE);
  renderActivitiesTable();

  // 6. Compute RFM, Whales, and render
  const rfmResult = calculateRFM(cachedActivities);
  state.rfm.data = rfmResult.wallets;
  state.rfm.segments = rfmResult.segments;
  renderRFMView();

  // Compute and render Whale Concentration
  calculateHolders();
  renderWhalesTable();

  // 7. Render charts
  if (cachedTransfers.length > 0) {
    renderVolumeChart();
    renderGasChart();
  }
  if (cachedActivities.length > 0) {
    renderActivityChart(cachedActivities.slice(0, 150));
  }

  if (btn) {
    btn.disabled = false;
    btn.style.opacity = '1';
  }
}

// ── Sidebar Toggle Binding ──────────────────────────────────────────────────

function bindSidebarToggle() {
  const btn = document.getElementById('toggleSidebarBtn');
  const sidebar = document.getElementById('sidebar');
  if (!btn || !sidebar) return;

  btn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
  });
}

// ── Timeframe Bindings ──────────────────────────────────────────────────────

function bindTimeframeSelector() {
  // Bind Volume Timeframe Selector
  const volumeContainer = document.getElementById('volumeTimeframeSelector');
  if (volumeContainer) {
    const buttons = volumeContainer.querySelectorAll('.timeframe-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.volumeTimeframe = btn.getAttribute('data-timeframe');
        if (cachedTransfers.length > 0) {
          renderVolumeChart();
        }
      });
    });
  }

  // Bind Gas Timeframe Selector
  const gasContainer = document.getElementById('gasTimeframeSelector');
  if (gasContainer) {
    const buttons = gasContainer.querySelectorAll('.timeframe-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.gasTimeframe = btn.getAttribute('data-timeframe');
        if (cachedTransfers.length > 0) {
          renderGasChart();
        }
      });
    });
  }
}

// ── Initialization ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  console.log('[Terminal] Web3 Analytics Terminal initializing…');

  // Bind side-menu navigation
  bindSidebarNavigation();

  // Bind table/global search actions
  bindTableSearchFilters();

  // Bind global timeframe selector buttons
  bindTimeframeSelector();

  // Bind collapsible sidebar toggle button
  bindSidebarToggle();

  // Initialize and load datasets
  refreshAll();

  // Auto-refresh stats/events periodically
  setInterval(refreshAll, AUTO_REFRESH_MS);
});
