/**
 * Web3 Analytics Terminal — Frontend Application Logic
 * ─────────────────────────────────────────────────────────
 * Elite, interactive trading-terminal dashboard logic.
 * Manages tabs, state, real-time RFM segment API integrations,
 * customized glowing Chart.js curves, sliding detail drawer,
 * and immediate clipboard micro-interactions.
 */

// ── Configuration ──────────────────────────────────────────────────────────
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol.startsWith('file')
  ? 'http://localhost:3001'
  : 'https://your-backend-service.onrender.com'; // Ganti dengan URL backend Render/Railway Anda setelah di-deploy
const PAGE_SIZE = 15;
const AUTO_REFRESH_MS = 30000; // 30 seconds

// ── State ──────────────────────────────────────────────────────────────────
let state = {
  activeTab: 'overview',
  transfers: { page: 1, data: [] },
  activities: { page: 1, data: [] },
  rfm: { data: [], segments: {} },
  stats: null,
  health: null,
  charts: {
    volume: null,
    activity: null,
    cohort: null
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
 * API Fetch Wrapper
 */
async function apiFetch(endpoint) {
  try {
    const response = await fetch(`${API_BASE}${endpoint}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.warn(`[API] Failed to fetch ${endpoint}:`, err.message);
    return null;
  }
}

// ── Data Ingestion & Sync ──────────────────────────────────────────────────

async function triggerManualIngestion() {
  const btn = document.getElementById('triggerIngestBtn');
  btn.disabled = true;
  btn.classList.add('syncing');
  btn.querySelector('span').textContent = 'Syncing...';

  try {
    const res = await fetch(`${API_BASE}/ingest`, { method: 'POST' });
    const data = await res.json();
    console.log('[Ingestor] Manual ingestion complete:', data);
    
    // Refresh stats after backfill
    await refreshAll();
  } catch (err) {
    console.error('[Ingestor] Ingestion trigger failed:', err);
  } finally {
    btn.disabled = false;
    btn.classList.remove('syncing');
    btn.querySelector('span').textContent = 'Trigger Ingest';
  }
}

// ── Core API Fetchers ──────────────────────────────────────────────────────

async function fetchStats() {
  const data = await apiFetch('/api/stats');
  if (data) {
    state.stats = data;
    renderKPIs();
  }
}

async function fetchHealth() {
  const data = await apiFetch('/health');
  if (data) {
    state.health = data;
    renderStatus();
  } else {
    renderOffline();
  }
}

async function fetchTransfers(page = 1) {
  const offset = (page - 1) * PAGE_SIZE;
  const data = await apiFetch(`/api/transfers?limit=${PAGE_SIZE}&offset=${offset}`);
  if (data) {
    state.transfers.data = data.transfers;
    state.transfers.page = page;
    renderTransfersTable();
    
    // If overview is active, render the live feed lists
    if (state.activeTab === 'overview') {
      renderLiveFeed(data.transfers);
    }
  }
}

async function fetchActivities(page = 1) {
  const offset = (page - 1) * PAGE_SIZE;
  const data = await apiFetch(`/api/activities?limit=${PAGE_SIZE}&offset=${offset}`);
  if (data) {
    state.activities.data = data.activities;
    state.activities.page = page;
    renderActivitiesTable();
  }
}

async function fetchRFM() {
  const data = await apiFetch('/api/rfm');
  if (data) {
    state.rfm.data = data.wallets || [];
    state.rfm.segments = data.segments || {};
    renderRFMView();
  }
}

async function fetchChartData() {
  // Volume rolling chart (rolling last 100 transfers for grouping)
  const data = await apiFetch('/api/transfers?limit=150&offset=0');
  if (data && data.transfers.length > 0) {
    renderVolumeChart(data.transfers);
  }

  // Type ratio chart
  const actData = await apiFetch('/api/activities?limit=150&offset=0');
  if (actData && actData.activities.length > 0) {
    renderActivityChart(actData.activities);
  }
}

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
        <span class="address-pill" onclick="openWalletDrawer('${a.wallet_address}')" title="Click to inspect Wallet">
          ${truncate(a.wallet_address)}
        </span>
      </td>
      <td>
        <span class="badge-action-type ${a.activity_type.toLowerCase()}">${a.activity_type}</span>
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
    container.innerHTML = '<div class="segment-stat-placeholder">Awaiting database sync...</div>';
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

function renderVolumeChart(transfers) {
  // Aggregate transfers by date
  const dailyVolume = {};
  const dailyCount = {};

  transfers.forEach(t => {
    const date = new Date(t.block_timestamp).toISOString().split('T')[0];
    if (!dailyVolume[date]) {
      dailyVolume[date] = 0;
      dailyCount[date] = 0;
    }
    const val = parseFloat(t.value) / 1e18;
    dailyVolume[date] += val;
    dailyCount[date] += 1;
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

  // Multi-gradient glowing borders
  const gradFill1 = ctx.createLinearGradient(0, 0, 0, 260);
  gradFill1.addColorStop(0, 'rgba(6, 182, 212, 0.2)');
  gradFill1.addColorStop(1, 'rgba(6, 182, 212, 0.00)');

  const gradFill2 = ctx.createLinearGradient(0, 0, 0, 260);
  gradFill2.addColorStop(0, 'rgba(139, 92, 246, 0.12)');
  gradFill2.addColorStop(1, 'rgba(139, 92, 246, 0.00)');

  state.charts.volume = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels.map(d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
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

// ── Pagination and Pagination Handlers ─────────────────────────────────────

function changePage(table, delta) {
  if (table === 'transfers') {
    const newPage = state.transfers.page + delta;
    if (newPage < 1) return;
    if (delta > 0 && state.transfers.data.length < PAGE_SIZE) return;
    fetchTransfers(newPage);
  } else if (table === 'activities') {
    const newPage = state.activities.page + delta;
    if (newPage < 1) return;
    if (delta > 0 && state.activities.data.length < PAGE_SIZE) return;
    fetchActivities(newPage);
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
        fetchChartData();
        renderLiveFeed(state.transfers.data);
      }
    });
  });
}

// ── Search filters ─────────────────────────────────────────────────────────

function bindTableSearchFilters() {
  // Transfers Local filter
  const transfersSearch = document.getElementById('transfersLocalSearch');
  if (transfersSearch) {
    transfersSearch.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      if (!q) {
        renderTransfersTable();
        return;
      }
      const filtered = state.transfers.data.filter(
        t => t.transaction_hash.toLowerCase().includes(q) || 
             t.from_address.toLowerCase().includes(q) || 
             t.to_address.toLowerCase().includes(q)
      );
      renderTransfersTable(filtered);
    });
  }

  // Activities Local filter
  const activitiesSearch = document.getElementById('activitiesLocalSearch');
  if (activitiesSearch) {
    activitiesSearch.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      if (!q) {
        renderActivitiesTable();
        return;
      }
      const filtered = state.activities.data.filter(
        a => a.wallet_address.toLowerCase().includes(q) || 
             a.activity_type.toLowerCase().includes(q) ||
             a.transaction_hash.toLowerCase().includes(q)
      );
      renderActivitiesTable(filtered);
    });
  }

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
  btn.disabled = true;
  btn.style.opacity = '0.6';

  await Promise.all([
    fetchHealth(),
    fetchStats(),
    fetchTransfers(state.transfers.page),
    fetchActivities(state.activities.page),
    fetchRFM(),
    fetchChartData()
  ]);

  btn.disabled = false;
  btn.style.opacity = '1';
}

// ── Initialization ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  console.log('[Terminal] Web3 Analytics Terminal initializing…');

  // Bind side-menu navigation
  bindSidebarNavigation();

  // Bind table/global search actions
  bindTableSearchFilters();

  // Initialize and load datasets
  refreshAll();

  // Auto-refresh stats/events periodically
  setInterval(refreshAll, AUTO_REFRESH_MS);
});
