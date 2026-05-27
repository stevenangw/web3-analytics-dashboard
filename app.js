/**
 * Web3 Analytics Terminal — Frontend Application Logic
 * ─────────────────────────────────────────────────────────
 * Elite, interactive trading-terminal dashboard logic.
 * Manages tabs, state, real-time RFM segment API integrations,
 * customized glowing Chart.js curves, sliding detail drawer,
 * and immediate clipboard micro-interactions.
 */

// ── Configuration ──────────────────────────────────────────────────────────
// ── Configuration ──────────────────────────────────────────────────────────
const PAGE_SIZE = 15;
const AUTO_REFRESH_MS = 30000; // 30 seconds

// Supabase Cloud standalone fallback credentials
const SUPABASE_URL = 'https://gqlgcunzwpzanfkgjlkp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdxbGdjdW56d3B6YW5ma2dqbGtwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NjgxOTUsImV4cCI6MjA5NTA0NDE5NX0.bEc9Fio5Lf4z2Y_tolbes7FW_OcsK1oclfzSjhEYsbs'; // Configure direct-to-cloud serverless fallback

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
  rfm: { page: 1, data: [], allData: [], segments: {} },
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
 * Compute responsive truncation lengths based on viewport width.
 * Desktop (>960): generous display. Tablet (768-960): moderate. Mobile (<768): compact.
 */
function getAdaptiveSlice() {
  const w = window.innerWidth;
  if (w >= 1200) return { addrStart: 10, addrEnd: 8, hashStart: 16, hashEnd: 10 };
  if (w >= 960)  return { addrStart: 8,  addrEnd: 6, hashStart: 12, hashEnd: 8 };
  if (w >= 768)  return { addrStart: 6,  addrEnd: 4, hashStart: 10, hashEnd: 6 };
  return { addrStart: 5, addrEnd: 4, hashStart: 8, hashEnd: 4 };
}

/**
 * Truncate an Ethereum address or hash for display.
 * When isAddress=true, uses adaptive viewport-based lengths.
 */
function truncate(str, start, end) {
  if (!str || str === '—') return '—';
  const adaptive = getAdaptiveSlice();
  const s = start !== undefined ? start : adaptive.addrStart;
  const e = end !== undefined ? end : adaptive.addrEnd;
  if (str.length <= s + e + 3) return str;
  return `${str.slice(0, s)}…${str.slice(-e)}`;
}

/**
 * Re-truncate all visible address pills and tx hashes based on current viewport.
 * Call after any table render or on window resize.
 */
function adaptAddresses() {
  const addrSteps = [
    { start: 42, end: 0 },
    { start: 16, end: 14 },
    { start: 12, end: 10 },
    { start: 8, end: 6 },
    { start: 6, end: 4 },
    { start: 5, end: 4 }
  ];

  const hashSteps = [
    { start: 66, end: 0 },
    { start: 24, end: 20 },
    { start: 16, end: 12 },
    { start: 12, end: 8 },
    { start: 8, end: 6 },
    { start: 6, end: 4 }
  ];

  function setElementStep(el, stepIdx, type) {
    const attr = type === 'addr' ? 'data-full-addr' : 'data-full-hash';
    const full = el.getAttribute(attr);
    if (!full) return;

    const steps = type === 'addr' ? addrSteps : hashSteps;
    const step = steps[stepIdx];

    if (step.start >= full.length) {
      el.textContent = full;
    } else {
      el.textContent = `${full.slice(0, step.start)}…${full.slice(-step.end)}`;
    }
  }

  // 1. Process all responsive table containers
  document.querySelectorAll('.table-responsive').forEach(container => {
    const table = container.querySelector('table');
    if (!table) return;

    const addrEls = container.querySelectorAll('[data-full-addr]');
    const hashEls = container.querySelectorAll('[data-full-hash]');
    if (addrEls.length === 0 && hashEls.length === 0) return;

    for (let step = 0; step < addrSteps.length; step++) {
      addrEls.forEach(el => setElementStep(el, step, 'addr'));
      hashEls.forEach(el => setElementStep(el, step, 'hash'));

      let hasOverflow = false;
      
      // Check table overflow
      if (table.scrollWidth > container.clientWidth) {
        hasOverflow = true;
      }

      // Check individual elements relative to parent cells
      if (!hasOverflow) {
        const allEls = [...addrEls, ...hashEls];
        for (const el of allEls) {
          const parent = el.closest('td') || el.parentElement;
          if (!parent) continue;

          const parentStyle = window.getComputedStyle(parent);
          const paddingLeft = parseFloat(parentStyle.paddingLeft) || 0;
          const paddingRight = parseFloat(parentStyle.paddingRight) || 0;
          const parentWidth = parent.clientWidth || parent.getBoundingClientRect().width;
          const parentAvailableWidth = parentWidth - paddingLeft - paddingRight;

          if (el.getBoundingClientRect().width > parentAvailableWidth) {
            hasOverflow = true;
            break;
          }
        }
      }

      if (!hasOverflow) {
        break;
      }
    }
  });

  // 2. Process feed container
  document.querySelectorAll('.feed-container').forEach(container => {
    const addrEls = container.querySelectorAll('[data-full-addr]');
    if (addrEls.length === 0) return;

    for (let step = 0; step < addrSteps.length; step++) {
      addrEls.forEach(el => setElementStep(el, step, 'addr'));

      let hasOverflow = false;
      const feedItems = container.querySelectorAll('.feed-item');
      for (const item of feedItems) {
        if (item.scrollWidth > item.clientWidth) {
          hasOverflow = true;
          break;
        }
      }

      if (!hasOverflow && (container.scrollWidth <= container.clientWidth)) {
        break;
      }
    }
  });

  // 3. Process drawer history list and the wallet drawer itself
  document.querySelectorAll('.drawer-history-list, .wallet-drawer').forEach(container => {
    const addrEls = container.querySelectorAll('[data-full-addr]');
    const hashEls = container.querySelectorAll('[data-full-hash]');
    if (addrEls.length === 0 && hashEls.length === 0) return;

    for (let step = 0; step < addrSteps.length; step++) {
      addrEls.forEach(el => setElementStep(el, step, 'addr'));
      hashEls.forEach(el => setElementStep(el, step, 'hash'));

      let hasOverflow = false;
      const items = container.querySelectorAll('.history-item');
      for (const item of items) {
        if (item.scrollWidth > item.clientWidth) {
          hasOverflow = true;
          break;
        }
      }

      if (!hasOverflow && (container.scrollWidth <= container.clientWidth)) {
        break;
      }
    }
  });

  // 4. Handle standalone elements
  const allAddrEls = document.querySelectorAll('[data-full-addr]');
  const allHashEls = document.querySelectorAll('[data-full-hash]');
  
  const handledSelector = '.table-responsive [data-full-addr], .feed-container [data-full-addr], .drawer-history-list [data-full-addr], .wallet-drawer [data-full-addr]';
  const handledHashSelector = '.table-responsive [data-full-hash], .feed-container [data-full-hash], .drawer-history-list [data-full-hash], .wallet-drawer [data-full-hash]';

  const handledAddrs = new Set(document.querySelectorAll(handledSelector));
  const handledHashes = new Set(document.querySelectorAll(handledHashSelector));

  const w = window.innerWidth;
  let fallbackStep = 4;
  if (w >= 1200) fallbackStep = 2;
  else if (w >= 960) fallbackStep = 3;
  else if (w >= 768) fallbackStep = 4;
  else fallbackStep = 5;

  allAddrEls.forEach(el => {
    if (!handledAddrs.has(el)) {
      setElementStep(el, fallbackStep, 'addr');
    }
  });

  allHashEls.forEach(el => {
    if (!handledHashes.has(el)) {
      setElementStep(el, fallbackStep, 'hash');
    }
  });
}

let _adaptDebounce;
window.addEventListener('resize', () => {
  clearTimeout(_adaptDebounce);
  _adaptDebounce = setTimeout(adaptAddresses, 100);
});

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
function formatRecencyDays(days) {
  if (days === undefined || days === null) return 'N/A';
  if (days < 1) return 'Today';
  if (days < 2) return 'Yesterday';
  return `${Math.floor(days)} days ago`;
}

/**
 * Format date string to YYYY-MM-DD HH:mm for readable display
 */
function formatReadableDate(dateString) {
  if (!dateString) return '—';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '—';
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function formatTime(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  
  const days = Math.floor(diffMin / 1440);
  if (days < 30) return formatRecencyDays(days);
  
  return formatReadableDate(isoString);
}

/**
 * Copy a string to user's clipboard and trigger a toast notification.
 */
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied to clipboard');
  }).catch(err => {
    console.error('[Clipboard] Failed to copy:', err);
  });
}

/**
 * Show a toast notification with a message.
 */
function showToast(message) {
  const toast = document.getElementById('copyToast');
  if (toast) {
    toast.querySelector('span').textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }
}

/**
 * REST API Fetcher
 */
async function apiFetch(endpoint) {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const baseUrl = isLocal ? 'http://localhost:3001' : '';

  try {
    const response = await fetch(`${baseUrl}${endpoint}`);
    if (response.ok) {
      const json = await response.json();
      if (json.success) return json.data;
    }
  } catch (err) {
    console.warn(`[API REST] Failed to fetch from local endpoint ${endpoint}, attempting Supabase Cloud fallback...`);
  }

  // Fallback: Query Supabase REST API directly if URL and Anon Key are set
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      let table = '';
      let selectParams = '';
      if (endpoint.startsWith('/api/transfers')) {
        table = 'token_transfers';
        selectParams = 'select=*&order=block_timestamp.desc&limit=1000';
      } else if (endpoint.startsWith('/api/activities')) {
        table = 'user_activities';
        selectParams = 'select=*&order=block_timestamp.desc&limit=1000';
      }

      if (table) {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${selectParams}`, {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Range-Unit': 'items'
          }
        });
        if (response.ok) {
          const data = await response.json();
          if (endpoint.startsWith('/api/transfers')) {
            return { transfers: data };
          } else if (endpoint.startsWith('/api/activities')) {
            return { activities: data };
          }
        }
      }
    } catch (sbErr) {
      console.error('[Supabase REST] direct fetch failed:', sbErr.message);
    }
  }

  return null;
}

/**
 * Generate client-side mock history if both local backend and Supabase Cloud are down or unconfigured.
 */
function generateClientMockData() {
  console.log('[App] 🛡️ Running in local offline demonstration mode. Generating high-fidelity mock data.');
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
    const ageMs = i * 9 * 3600 * 1000;
    const timestamp = new Date(now - ageMs).toISOString();
    const fromIdx = Math.floor(Math.random() * wallets.length);
    let toIdx = Math.floor(Math.random() * wallets.length);
    while (toIdx === fromIdx) {
      toIdx = Math.floor(Math.random() * wallets.length);
    }

    const from = wallets[fromIdx];
    const to = wallets[toIdx];
    const value = Math.floor(Math.random() * 4900) + 100;
    const valueWei = value.toString() + '000000000000000000';
    const blockNumber = 12000000 + (80 - i) * 5;
    const gasUsed = Math.floor(Math.random() * 30000) + 21000;
    const gasPrice = (Math.floor(Math.random() * 20) + 15).toString() + '000000000';
    const txHash = '0x' + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join('');

    transfers.push({
      id: 80 - i + 1,
      transaction_hash: txHash,
      block_number: blockNumber,
      block_timestamp: timestamp,
      from_address: from,
      to_address: to,
      value: valueWei,
      gas_used: gasUsed,
      gas_price: gasPrice
    });

    activities.push({
      id: (80 - i) * 2 + 1,
      transaction_hash: txHash,
      wallet_address: from,
      activity_type: 'TRANSFER',
      amount: valueWei,
      block_number: blockNumber,
      block_timestamp: timestamp
    });

    activities.push({
      id: (80 - i) * 2 + 2,
      transaction_hash: txHash,
      wallet_address: to,
      activity_type: 'RECEIVE',
      amount: valueWei,
      block_number: blockNumber,
      block_timestamp: timestamp
    });
  }

  return { transfers, activities };
}

// ── Data Ingestion & Sync ──────────────────────────────────────────────────

async function triggerManualIngestion() {
  const btn = document.getElementById('triggerIngestBtn');
  btn.disabled = true;
  btn.classList.add('syncing');
  btn.querySelector('span').textContent = 'Syncing...';

  try {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    if (isLocal) {
      const res = await fetch('http://localhost:3001/ingest', { method: 'POST' });
      const data = await res.json();
      console.log('[Ingestor] Manual ingestion complete:', data);
    } else {
      showToast('Ingestor runs locally — start it via npm start');
    }
    
    await refreshAll();
  } catch (err) {
    console.error('[Ingestor] Ingestion trigger failed:', err);
    showToast('Could not connect to local ingestor node');
  } finally {
    btn.disabled = false;
    btn.classList.remove('syncing');
    btn.querySelector('span').textContent = 'Ingest';
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

  // Calculate total supply to show share percentage (safe BigInt conversion)
  const totalSupply = holders.reduce((acc, h) => acc + BigInt(h.balance || 0), BigInt(0));

  tbody.innerHTML = holders.slice(0, 15).map((h, index) => {
    const balanceBI = BigInt(h.balance || 0);
    const share = totalSupply > BigInt(0) ? (Number(balanceBI * BigInt(10000) / totalSupply) / 100) : 0;
    return `
      <tr>
        <td class="mono font-600 align-center" style="color: ${index < 3 ? 'var(--accent)' : 'var(--muted)'}">#${index + 1}</td>
        <td>
          <span class="address-pill" data-full-addr="${h.address}" onclick="openWalletDrawer('${h.address}')" title="Click to inspect Wallet">
            ${truncate(h.address)}
          </span>
        </td>
        <td class="align-right mono font-600 text-title">${parseFloat(formatTokenValue(balanceBI)).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
        <td class="align-right mono text-title" style="color: var(--accent); font-weight: 500;">${share.toFixed(2)}%</td>
      </tr>
    `;
  }).join('');
  adaptAddresses();
}

// ── Direct Supabase Mock Status Fetchers ────────────────────────────────────

async function fetchHealth() {
  try {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const baseUrl = isLocal ? 'http://localhost:3001' : '';
    const res = await fetch(`${baseUrl}/health`);
    if (res.ok) {
      const json = await res.json();
      if (json.success) {
        state.health = json.data;
        renderStatus();
        return;
      }
    }
  } catch (err) {
    console.warn('[Health] Local health endpoint unreachable, running in client-resilient mode');
  }

  // Direct Cloud or Standing Mock health fallback
  state.health = {
    status: 'ok',
    mode: (SUPABASE_URL && SUPABASE_ANON_KEY) ? 'cloud' : 'standalone',
    uptime: performance.now() / 1000,
    lastBlock: cachedTransfers.length > 0 ? Math.max(...cachedTransfers.map(t => parseInt(t.block_number, 10))) : 0
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
  const latestBlockValueEl = document.getElementById('latestBlockValue');
  if (latestBlockValueEl) {
    latestBlockValueEl.textContent = s.latestBlock ? `#${formatNumber(s.latestBlock)}` : '#—';
  }

  // Dynamic non-hardcoded Trend Calculations from cached data
  let transfersTrendPct = 12; // default dynamic baselines
  let activitiesTrendPct = 8;
  let walletsTrendPct = 5;

  if (cachedTransfers && cachedTransfers.length > 0) {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    
    const txsLast24h = cachedTransfers.filter(t => (now - new Date(t.block_timestamp).getTime()) <= oneDayMs).length;
    const txsPrev24h = cachedTransfers.filter(t => {
      const diff = now - new Date(t.block_timestamp).getTime();
      return diff > oneDayMs && diff <= 2 * oneDayMs;
    }).length;

    if (txsPrev24h > 0) {
      transfersTrendPct = Math.round(((txsLast24h - txsPrev24h) / txsPrev24h) * 100);
    } else if (txsLast24h > 0) {
      transfersTrendPct = 100;
    } else {
      transfersTrendPct = 0;
    }
  }

  if (cachedActivities && cachedActivities.length > 0) {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    const actsLast24h = cachedActivities.filter(a => (now - new Date(a.block_timestamp).getTime()) <= oneDayMs).length;
    const actsPrev24h = cachedActivities.filter(a => {
      const diff = now - new Date(a.block_timestamp).getTime();
      return diff > oneDayMs && diff <= 2 * oneDayMs;
    }).length;

    if (actsPrev24h > 0) {
      activitiesTrendPct = Math.round(((actsLast24h - actsPrev24h) / actsPrev24h) * 100);
    } else if (actsLast24h > 0) {
      activitiesTrendPct = 100;
    } else {
      activitiesTrendPct = 0;
    }
    
    // Unique active wallets in the last 24h vs preceding 24h
    const walletsLast24h = new Set(cachedActivities.filter(a => (now - new Date(a.block_timestamp).getTime()) <= oneDayMs).map(a => a.wallet_address)).size;
    const walletsPrev24h = new Set(cachedActivities.filter(a => {
      const diff = now - new Date(a.block_timestamp).getTime();
      return diff > oneDayMs && diff <= 2 * oneDayMs;
    }).map(a => a.wallet_address)).size;

    if (walletsPrev24h > 0) {
      walletsTrendPct = Math.round(((walletsLast24h - walletsPrev24h) / walletsPrev24h) * 100);
    } else if (walletsLast24h > 0) {
      walletsTrendPct = 100;
    } else {
      walletsTrendPct = 0;
    }
  }

  const formatTrend = (pct, label) => {
    if (pct > 0) return `<span class="trend-up">▲ ${pct}%</span> · ${label}`;
    if (pct < 0) return `<span class="trend-down">▼ ${Math.abs(pct)}%</span> · ${label}`;
    return `<span class="trend-neutral">● 0%</span> · ${label}`;
  };

  const trendTransfersEl = document.querySelector('#kpiTransfers .kpi-trend');
  if (trendTransfersEl) trendTransfersEl.innerHTML = formatTrend(transfersTrendPct, 'total transfers');

  const trendActivitiesEl = document.querySelector('#kpiActivities .kpi-trend');
  if (trendActivitiesEl) trendActivitiesEl.innerHTML = formatTrend(activitiesTrendPct, 'total activities');

  const trendWalletsEl = document.querySelector('#kpiWallets .kpi-trend');
  if (trendWalletsEl) trendWalletsEl.innerHTML = formatTrend(walletsTrendPct, 'total wallets');

  document.querySelectorAll('.kpi-value').forEach(el => el.classList.remove('skeleton'));
}

function renderStatus() {
  const h = state.health;
  const pulse = document.getElementById('sidebarPulse');
  const text = document.getElementById('syncStatusText');
  const badge = document.getElementById('modeBadge');

  const mPulse = document.getElementById('mobileSidebarPulse');
  const mText = document.getElementById('mobileSyncStatusText');

  if (h && h.status === 'ok') {
    if (pulse) {
      pulse.classList.remove('offline');
      pulse.classList.add('anim-pulse');
    }
    if (text) {
      text.textContent = 'Live';
    }
    if (mPulse) {
      mPulse.classList.remove('offline');
      mPulse.classList.add('anim-pulse');
    }
    if (mText) {
      mText.textContent = 'Live';
    }

    if (badge) {
      if (h.mode === 'hybrid') {
        badge.textContent = '🌐 Sepolia';
        badge.className = 'badge badge-live';
      } else if (h.mode === 'local') {
        badge.textContent = '🏠 Local Node';
        badge.className = 'badge badge-local';
      } else if (h.mode === 'cloud') {
        badge.textContent = '☁ Supabase';
        badge.className = 'badge badge-live';
      } else if (h.mode === 'standalone') {
        badge.textContent = '🤖 Standalone';
        badge.className = 'badge badge-local';
      } else {
        badge.textContent = h.mode;
        badge.className = 'badge';
      }
    }
  }
}

function renderOffline() {
  const pulse = document.getElementById('sidebarPulse');
  const text = document.getElementById('syncStatusText');
  const badge = document.getElementById('modeBadge');

  const mPulse = document.getElementById('mobileSidebarPulse');
  const mText = document.getElementById('mobileSyncStatusText');

  if (pulse) {
    pulse.classList.add('offline');
    pulse.classList.remove('anim-pulse');
  }
  if (text) {
    text.textContent = 'Offline';
  }
  if (mPulse) {
    mPulse.classList.add('offline');
    mPulse.classList.remove('anim-pulse');
  }
  if (mText) {
    mText.textContent = 'Offline';
  }
  if (badge) {
    badge.textContent = 'Disconnected';
    badge.className = 'badge';
  }
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
        <span class="tx-hash-link" data-full-hash="${t.transaction_hash}" onclick="copyToClipboard('${t.transaction_hash}')" title="Click to copy Transaction Hash">
          ${truncate(t.transaction_hash)}
        </span>
      </td>
      <td class="mono font-500">${formatNumber(t.block_number)}</td>
      <td>
        <span class="address-pill" data-full-addr="${t.from_address}" onclick="openWalletDrawer('${t.from_address}')" title="Click to inspect Wallet">
          ${truncate(t.from_address)}
        </span>
      </td>
      <td>
        <span class="address-pill" data-full-addr="${t.to_address}" onclick="openWalletDrawer('${t.to_address}')" title="Click to inspect Wallet">
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
          <span class="address-pill" data-full-addr="${a.sender || ''}" onclick="openWalletDrawer('${a.sender || '—'}')" title="Click to inspect Sender Wallet">
            ${truncate(a.sender)}
          </span>
          <span style="color: var(--muted); font-size: 11px;">➔</span>
          <span class="address-pill" data-full-addr="${a.receiver || ''}" onclick="openWalletDrawer('${a.receiver || '—'}')" title="Click to inspect Receiver Wallet">
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
        <span class="tx-hash-link" data-full-hash="${a.transaction_hash}" onclick="copyToClipboard('${a.transaction_hash}')" title="Copy Hash">
          ${truncate(a.transaction_hash)}
        </span>
      </td>
      <td class="align-right text-muted">${formatTime(a.block_timestamp)}</td>
    </tr>
  `).join('');

  pageInfo.textContent = `Page ${state.activities.page}`;
  adaptAddresses();
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
        <div class="feed-item-main">
          <div class="feed-route">
            <span class="address" data-full-addr="${t.from_address}" onclick="openWalletDrawer('${t.from_address}')" title="${t.from_address}">${truncate(t.from_address)}</span>
            <span class="transfer-arrow">→</span>
            <span class="address" data-full-addr="${t.to_address}" onclick="openWalletDrawer('${t.to_address}')" title="${t.to_address}">${truncate(t.to_address)}</span>
          </div>
          <div class="feed-time-sub">${formatTime(t.block_timestamp)}</div>
        </div>
        <div class="feed-item-amount font-600">
          ${val.toFixed(2)} tokens
        </div>
      </div>
    `;
  }).join('');
  adaptAddresses();
}

// ── RFM View Rendering ─────────────────────────────────────────────────────

function renderRFMView(filteredData = null) {
  const tbody = document.getElementById('rfmTableBody');
  const countLabel = document.getElementById('rfmTotalWalletsText');
  const pageInfo = document.getElementById('rfmPageInfo');

  const allData = state.rfm.allData || [];
  const data = filteredData || state.rfm.data;

  countLabel.textContent = `${formatNumber(allData.length)} wallet`;

  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state-cell">No matching classified profiles.</td></tr>';
    renderRFMStatSummaries();
    renderRFMCohortChart();
    if (pageInfo) pageInfo.textContent = `Page ${state.rfm.page}`;
    return;
  }

  tbody.innerHTML = data.map(w => `
    <tr>
      <td>
        <span class="address-pill" data-full-addr="${w.wallet_address}" onclick="openWalletDrawer('${w.wallet_address}')" title="Inspect profile">
          ${truncate(w.wallet_address)}
        </span>
      </td>
      <td>
        <span class="rfm-tag ${w.segment.toLowerCase().replace(' ', '-')}">${w.segment}</span>
      </td>
      <td class="align-right mono font-500">${formatRecencyDays(w.recency_days)}</td>
      <td class="align-right mono text-title">${formatNumber(w.frequency)}</td>
      <td class="align-right mono text-title font-600">${parseFloat(formatTokenValue(w.monetary)).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
      <td class="align-right mono font-600 text-title" style="color: var(--accent-cyan)">${w.rfm_score}</td>
    </tr>
  `).join('');

  if (pageInfo) {
    pageInfo.textContent = `Page ${state.rfm.page}`;
  }

  // Render side list summaries (Overview of percentages)
  renderRFMStatSummaries();

  // Render or update RFM cohort chart
  renderRFMCohortChart();
  adaptAddresses();
}

function renderRFMStatSummaries() {
  const container = document.getElementById('segmentStatsSummaryList');
  if (!state.rfm.data || state.rfm.data.length === 0) {
    container.innerHTML = '<div class="segment-stat-placeholder">No active cohorts detected.</div>';
    return;
  }

  const total = (state.rfm.allData || []).length;
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
          <span class="segment-stat-title">${seg.name}</span>
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
  recencyVal.textContent = profile ? formatRecencyDays(profile.recency_days) : 'N/A';

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
            <span>Counterparty: <span class="history-counterparty" data-full-addr="${counterparty}">${truncate(counterparty, 6, 4)}</span></span>
            <span>Block <span class="mono">${t.block_number}</span></span>
          </div>
          <div class="history-item-bottom">
            <span>Tx: <span class="history-tx" data-full-hash="${t.transaction_hash}">${truncate(t.transaction_hash, 10, 6)}</span></span>
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
  adaptAddresses();
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

  const gradient = ctx.createLinearGradient(0, 0, 0, 200);
  gradient.addColorStop(0, 'rgba(88, 126, 106, 0.25)'); // Muted Sage Accent Glow
  gradient.addColorStop(1, 'rgba(88, 126, 106, 0)');

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
          borderColor: '#587E6A', // Accent Muted Sage Green
          borderWidth: 2,
          fill: true,
          backgroundColor: gradient,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 6,
          pointBackgroundColor: '#587E6A',
          pointHoverBackgroundColor: '#587E6A',
          pointHoverBorderColor: '#fafafa',
          pointHoverBorderWidth: 2
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
          backgroundColor: 'rgba(20, 20, 25, 0.95)',
          borderColor: 'rgba(255, 255, 255, 0.08)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 12,
          titleFont: { weight: '700', family: "'Plus Jakarta Sans', sans-serif" },
          bodyFont: { family: "'Space Grotesk', monospace" }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: { maxTicksLimit: 10, font: { family: "'Space Grotesk', monospace" } }
        },
        y: {
          position: 'left',
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: {
            callback: val => val.toLocaleString(),
            font: { family: "'Space Grotesk', monospace" }
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
    if (l === 'TRANSFER') return '#B87C7C'; // Muted Rose
    if (l === 'RECEIVE') return '#648A74'; // Muted Sage Green
    return '#587E6A'; // Sage Accent
  });

  const borderColors = labels.map(l => {
    if (l === 'TRANSFER') return 'rgba(184, 124, 124, 0.15)';
    if (l === 'RECEIVE') return 'rgba(100, 138, 116, 0.15)';
    return 'rgba(88, 126, 106, 0.15)';
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
          cornerRadius: 0
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
    if (label === 'Champion') return '#587E6A';     // Muted Sage Green
    if (label === 'Loyal') return '#7A9687';        // Muted Sage variant
    if (label === 'New User') return '#C1A278';     // Muted Gold
    if (label === 'Potential') return '#8FA89B';    // Light Muted Sage
    if (label === 'At Risk') return '#B87C7C';      // Muted Rose
    return '#94A3B8';                               // Muted Slate
  });

  if (state.charts.cohort) {
    state.charts.cohort.destroy();
  }

  const canvas = document.getElementById('rfmCohortChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  state.charts.cohort = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Jumlah Wallet',
        data,
        backgroundColor: colors.map(c => c + '33'),
        borderColor: colors,
        borderWidth: 1.5,
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: 'rgba(20, 20, 25, 0.95)',
          borderColor: 'rgba(255, 255, 255, 0.08)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 12,
          titleFont: { weight: '700', family: "'Plus Jakarta Sans', sans-serif" },
          bodyFont: { family: "'Space Grotesk', monospace" }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: {
            color: '#8e8e93',
            font: { family: "'Space Grotesk', monospace" }
          }
        },
        y: {
          grid: { display: false },
          ticks: {
            color: '#fafafa',
            font: { family: "'Plus Jakarta Sans', sans-serif", weight: '500' }
          }
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

  const gradientGas = ctx.createLinearGradient(0, 0, 0, 200);
  gradientGas.addColorStop(0, 'rgba(193, 162, 120, 0.22)');
  gradientGas.addColorStop(1, 'rgba(193, 162, 120, 0)');

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
          label: 'Avg Gas Price (Gwei)',
          data: avgGasPriceData,
          borderColor: '#C1A278', // Amber/Gas color (Muted Gold)
          borderWidth: 2,
          fill: true,
          backgroundColor: gradientGas,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 6,
          pointBackgroundColor: '#C1A278',
          pointHoverBackgroundColor: '#C1A278',
          pointHoverBorderColor: '#fafafa',
          pointHoverBorderWidth: 2
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
          backgroundColor: 'rgba(20, 20, 25, 0.95)',
          borderColor: 'rgba(255, 255, 255, 0.08)',
          borderWidth: 1,
          padding: 12,
          cornerRadius: 12,
          titleFont: { weight: '700', family: "'Plus Jakarta Sans', sans-serif" },
          bodyFont: { family: "'Space Grotesk', monospace" }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: { maxTicksLimit: 10, font: { family: "'Space Grotesk', monospace" } }
        },
        y: {
          position: 'left',
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: {
            maxTicksLimit: 4,
            callback: val => val.toFixed(2) + ' Gwei',
            font: { family: "'Space Grotesk', monospace" }
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
    showToast('No data available to export');
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
  } else if (table === 'rfm') {
    const newPage = state.rfm.page + delta;
    if (newPage < 1) return;
    const offset = (newPage - 1) * PAGE_SIZE;
    if (offset >= (state.rfm.allData || []).length) return;
    state.rfm.page = newPage;
    state.rfm.data = state.rfm.allData.slice(offset, offset + PAGE_SIZE);
    renderRFMView();
  }
}

// ── Sidebar Switch Action Handlers ─────────────────────────────────────────

function bindSidebarNavigation() {
  const menuButtons = document.querySelectorAll('.menu-item');
  const panels = document.querySelectorAll('.tab-panel');

  menuButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      state.activeTab = targetTab;

      // Deactivate all, and activate all matching buttons on both sidebar & bottom nav
      menuButtons.forEach(b => {
        if (b.getAttribute('data-tab') === targetTab) {
          b.classList.add('active');
          b.setAttribute('aria-selected', 'true');
        } else {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        }
      });
      
      panels.forEach(p => p.classList.remove('active'));
      const activePanel = document.getElementById(`tab-${targetTab}`);
      if (activePanel) {
        activePanel.classList.add('active');
      }

      // Update Header Title
      const titles = {
        'overview': 'Dashboard Overview',
        'transfers': 'Token Transfers Ledger',
        'activities': 'Synthesized Wallet Activities',
        'rfm': 'RFM Segmentation'
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
        state.rfm.page = 1;
        state.rfm.data = (state.rfm.allData || []).slice(0, PAGE_SIZE);
        renderRFMView();
        return;
      }
      const filtered = (state.rfm.allData || []).filter(
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
  }

  // Show skeleton loading state on KPI values
  document.querySelectorAll('.kpi-value').forEach(el => el.classList.add('skeleton'));

  // 1. Fetch raw datasets from backend API securely
  let transfersRes = await apiFetch('/api/transfers?limit=1000');
  let activitiesRes = await apiFetch('/api/activities?limit=1000');
  let statsRes = await apiFetch('/api/stats');
  let rfmRes = await apiFetch('/api/rfm');
  let holdersRes = await apiFetch('/api/holders');

  const hasData = (transfersRes && transfersRes.transfers && transfersRes.transfers.length > 0);

  // Tertiary Fallback: Generate local mock history if both Express and Supabase Cloud have absolutely no data
  if (!hasData) {
    console.log('[App] Database is empty or unreachable. Populating resilient high-fidelity offline mock data...');
    const mock = generateClientMockData();
    transfersRes = { transfers: mock.transfers };
    activitiesRes = { activities: mock.activities };
    statsRes = null;
    rfmRes = null;
    holdersRes = null;
  }

  cachedTransfers = transfersRes ? transfersRes.transfers : [];
  cachedActivities = activitiesRes ? activitiesRes.activities : [];

  // 2. Fetch Health state
  await fetchHealth();

  // 3. Render KPIs
  if (statsRes) {
    state.stats = statsRes;
  } else {
    // Recalculate stats dynamically from cached data
    const totalTransfers = cachedTransfers.length;
    const totalActivities = cachedActivities.length;
    const uniqueWallets = new Set(cachedActivities.map(a => a.wallet_address)).size;
    const latestBlock = cachedTransfers.length > 0 ? Math.max(...cachedTransfers.map(t => parseInt(t.block_number, 10))) : 0;
    
    state.stats = {
      totalTransfers,
      totalActivities,
      uniqueWallets,
      latestBlock
    };
  }
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

  // 6. Set RFM & Holders from API or calculate on the fly
  if (rfmRes) {
    state.rfm.allData = rfmRes.wallets || [];
    state.rfm.segments = rfmRes.segments || {};
  } else {
    const computedRfm = calculateRFM(cachedActivities);
    state.rfm.allData = computedRfm.wallets || [];
    state.rfm.segments = computedRfm.segments || {};
  }
  state.rfm.page = state.rfm.page || 1;
  const rfmOffset = (state.rfm.page - 1) * PAGE_SIZE;
  state.rfm.data = state.rfm.allData.slice(rfmOffset, rfmOffset + PAGE_SIZE);
  renderRFMView();

  if (holdersRes) {
    state.holders = holdersRes || [];
  } else {
    state.holders = calculateHolders();
  }
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
    btn.style.opacity = '';
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

function bindThemeToggle() {
  const btn = document.getElementById('themeToggleBtn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const currentTheme = localStorage.getItem('color-scheme') || 'dark';
    const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';

    localStorage.setItem('color-scheme', nextTheme);
    document.documentElement.setAttribute('data-color-scheme', nextTheme);
    document.documentElement.style.setProperty('color-scheme', nextTheme);

    console.log(`[Terminal] Theme toggled to ${nextTheme}`);
    showToast(`Switched to ${nextTheme} mode`);
  });
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

  // Bind theme toggle action
  bindThemeToggle();

  // Initialize and load datasets
  refreshAll();

  // Auto-refresh stats/events periodically
  setInterval(refreshAll, AUTO_REFRESH_MS);
});
