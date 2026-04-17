/* ═══════════════════════════════════════════
   A股资产追踪器 — Frontend Logic
   Stores all data in localStorage.
   Fetches real-time quotes from /api/stocks (Express proxy → Sina Finance).
═══════════════════════════════════════════ */

const ALERT_THRESHOLD = 2.0;   // ±2% triggers an alert
const DIVIDEND_GOAL   = 100000; // ¥100,000
const REFRESH_MS      = 15000;  // 15s during market hours

// ─── State ───────────────────────────────
let portfolio    = [];   // { id, code, name, shares, costPrice }
let dividends    = [];   // { id, code, name, date, perShare, shares, taxRate, total }
let alertLog     = [];   // { id, code, name, type, changePct, price, time }
let priceAlerts  = {};   // code → { lower: number|null, upper: number|null }
let navHistory   = [];   // [{ date, value, cost }]
let watchlist    = [];   // { id, code, name, expectedDivPerShare, simShares }
let etfList      = [];   // { id, code, name, divPerUnit, simUnits }
let stockData    = {};   // code → Sina price object (live)
let charts       = {};   // Chart.js instances
let refreshTimer = null;
let alreadyAlerted = new Set();

// ─── Persistence ─────────────────────────
function loadState() {
  try {
    portfolio   = JSON.parse(localStorage.getItem('portfolio')   || '[]');
    dividends   = JSON.parse(localStorage.getItem('dividends')   || '[]');
    alertLog    = JSON.parse(localStorage.getItem('alertLog')    || '[]');
    priceAlerts = JSON.parse(localStorage.getItem('priceAlerts') || '{}');
    navHistory  = JSON.parse(localStorage.getItem('navHistory')  || '[]');
    watchlist   = JSON.parse(localStorage.getItem('watchlist')   || '[]');
    etfList     = JSON.parse(localStorage.getItem('etfList')     || '[]');
    // Restore today's already-fired alerts; discard previous days
    const today = todayStr();
    const saved = JSON.parse(localStorage.getItem('alreadyAlerted') || '[]');
    alreadyAlerted = new Set(saved.filter(k => k.startsWith(today)));
  } catch { portfolio = []; dividends = []; alertLog = []; priceAlerts = {}; navHistory = []; watchlist = []; etfList = []; }
}
function saveState() {
  localStorage.setItem('portfolio',    JSON.stringify(portfolio));
  localStorage.setItem('dividends',    JSON.stringify(dividends));
  localStorage.setItem('alertLog',     JSON.stringify(alertLog));
  localStorage.setItem('priceAlerts',  JSON.stringify(priceAlerts));
  localStorage.setItem('navHistory',   JSON.stringify(navHistory));
  localStorage.setItem('watchlist',    JSON.stringify(watchlist));
  localStorage.setItem('etfList',      JSON.stringify(etfList));
  localStorage.setItem('alreadyAlerted', JSON.stringify([...alreadyAlerted]));
}

// ─── Helpers ─────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function fmt(n, dec = 2) {
  if (n == null || isNaN(n)) return '--';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtPrice(n, dec = 2) {
  if (n == null || isNaN(n)) return '--';
  return '¥\u202F' + n.toLocaleString('zh-CN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtMoney(n) {
  if (n == null || isNaN(n)) return '¥ --';
  const prefix = n < 0 ? '-¥ ' : '¥ ';
  return prefix + Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '--';
  const sign = n > 0 ? '+' : '';
  return sign + fmt(n) + '%';
}
function pnlClass(n) {
  if (!n || n === 0) return 'pnl-zero';
  return n > 0 ? 'pnl-positive' : 'pnl-negative';
}
function changeClass(n) {
  if (!n || n === 0) return 'change-flat';
  return n > 0 ? 'change-up' : 'change-down';
}
function normalizeCode(raw) {
  raw = raw.trim().toLowerCase().replace(/\s/g, '');
  if (/^(sh|sz)\d{6}$/.test(raw)) return raw;
  if (/^\d{6}$/.test(raw)) {
    // 5x/6x → Shanghai (stocks + ETFs); 0x/1x/2x/3x → Shenzhen
    return (raw.startsWith('5') || raw.startsWith('6')) ? `sh${raw}` : `sz${raw}`;
  }
  return null;
}
function nowBJ() { return new Date(Date.now() + 8 * 3600000); }
function timeStr() {
  const d = nowBJ();
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
function todayStr() { return nowBJ().toISOString().slice(0, 10); }

// ─── Stock Data Fetch ─────────────────────
async function fetchStockData() {
  const allCodes = [...new Set([...portfolio.map(p => p.code), ...watchlist.map(w => w.code), ...etfList.map(e => e.code)])];
  if (!allCodes.length) return;
  const codes = allCodes.join(',');
  try {
    const res = await fetch(`/api/stocks?codes=${codes}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    for (const [code, info] of Object.entries(data)) {
      if (info.name) {
        portfolio.forEach(p => { if (p.code === code && !p.name) p.name = info.name; });
      }
    }
    stockData = data;
    checkAlerts();
    saveNavSnapshot();
    renderAll();
    document.getElementById('last-updated').textContent = '更新: ' + timeStr().slice(11);
  } catch (err) {
    showToast('获取行情失败: ' + err.message, 'error');
  }
}

// ─── Market Status ────────────────────────
async function updateMarketStatus() {
  try {
    const res = await fetch('/api/market-status');
    const { open } = await res.json();
    const badge = document.getElementById('market-badge');
    if (open) {
      badge.textContent = '交易中';
      badge.className = 'badge badge-open';
    } else {
      badge.textContent = '休市';
      badge.className = 'badge badge-closed';
    }
  } catch { /* ignore */ }
}

// ─── NAV Snapshot ─────────────────────────
function saveNavSnapshot() {
  if (!portfolio.length) return;
  const { totalValue, totalCost } = calcPortfolioSummary();
  if (!totalValue) return;
  const today = todayStr();
  const idx = navHistory.findIndex(n => n.date === today);
  const entry = { date: today, value: parseFloat(totalValue.toFixed(2)), cost: parseFloat(totalCost.toFixed(2)) };
  if (idx >= 0) navHistory[idx] = entry; else navHistory.push(entry);
  navHistory.sort((a, b) => a.date.localeCompare(b.date));
  if (navHistory.length > 365) navHistory = navHistory.slice(-365);
  saveState();
}

// ─── Alert System ─────────────────────────
function checkAlerts() {
  const newAlerts = [];
  for (const [code, info] of Object.entries(stockData)) {
    const pct = info.changePct;
    // Percentage-change alerts
    const today = todayStr();
    const pctKey = `${today}_${code}_pct`;
    if (!alreadyAlerted.has(pctKey) && Math.abs(pct) >= ALERT_THRESHOLD) {
      const type = pct > 0 ? 'up' : 'down';
      const entry = { id: uid(), code, name: info.name, type, changePct: pct, price: info.current, time: timeStr() };
      newAlerts.push(entry);
      alertLog.unshift(entry);
      alreadyAlerted.add(pctKey);
      triggerAlertNotification(entry);
    }
    // Custom price alerts
    const pa = priceAlerts[code];
    if (pa && info.current) {
      if (pa.upper != null && info.current >= pa.upper) {
        const key = `${today}_${code}_upper`;
        if (!alreadyAlerted.has(key)) {
          const entry = { id: uid(), code, name: info.name, type: 'up', changePct: pct, price: info.current, time: timeStr(), customAlert: `触及上限价 ¥${pa.upper}` };
          newAlerts.push(entry); alertLog.unshift(entry); alreadyAlerted.add(key);
          triggerAlertNotification(entry);
        }
      }
      if (pa.lower != null && info.current <= pa.lower) {
        const key = `${today}_${code}_lower`;
        if (!alreadyAlerted.has(key)) {
          const entry = { id: uid(), code, name: info.name, type: 'down', changePct: pct, price: info.current, time: timeStr(), customAlert: `触及下限价 ¥${pa.lower}` };
          newAlerts.push(entry); alertLog.unshift(entry); alreadyAlerted.add(key);
          triggerAlertNotification(entry);
        }
      }
    }
  }
  if (newAlerts.length) saveState();
}

function triggerAlertNotification(a) {
  const sign = a.type === 'up' ? '▲' : '▼';
  const suffix = a.customAlert ? ` [${a.customAlert}]` : '';
  const msg = `${a.name}(${a.code}) ${sign} ${fmtPct(a.changePct)} 现价 ¥${fmt(a.price)}${suffix}`;
  showToast(msg, a.type);
  if (Notification.permission === 'granted') {
    new Notification('A股价格预警', { body: msg, icon: '/favicon.ico' });
  } else if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// ─── Calculations ─────────────────────────
function calcPortfolioSummary() {
  let totalValue = 0, totalCost = 0, todayPnl = 0;
  for (const pos of portfolio) {
    const info = stockData[pos.code];
    if (!info) { totalCost += pos.costPrice * pos.shares; continue; }
    const value = info.current * pos.shares;
    const cost  = pos.costPrice * pos.shares;
    const todayChg = (info.current - info.prevClose) * pos.shares;
    totalValue += value;
    totalCost  += cost;
    todayPnl   += todayChg;
  }
  const totalPnl = totalValue - totalCost;
  return { totalValue, totalCost, totalPnl, todayPnl,
    totalPct: totalCost > 0 ? (totalPnl / totalCost) * 100 : 0,
    todayPct: totalCost  > 0 ? (todayPnl  / totalCost) * 100 : 0 };
}

function calcDividendTotal() {
  return dividends.reduce((s, d) => s + (d.total || 0), 0);
}

function calcEstimatedAnnualDiv() {
  let total = 0, count = 0;
  for (const pos of portfolio) {
    if (pos.expectedDivPerShare == null) continue;
    const taxRate = pos.expectedTaxRate ?? 1.0;
    total += pos.expectedDivPerShare * pos.shares * taxRate;
    count++;
  }
  return { total, count };
}

// Annual dividend yield for a stock (last 12 months dividends / current market value)
function calcAnnualDivYield(code, currentPrice, shares) {
  if (!currentPrice || !shares) return null;
  const cutoff = new Date(nowBJ().getTime() - 365 * 24 * 3600000).toISOString().slice(0, 10);
  const total = dividends
    .filter(d => d.code === code && d.date >= cutoff)
    .reduce((s, d) => s + d.total, 0);
  if (!total) return null;
  return (total / (currentPrice * shares)) * 100;
}

// ─── Render ───────────────────────────────
function renderAll() {
  renderSummaryCards();
  renderPortfolioTable();
  renderDividendTable();
  renderWatchlistTable();
  renderEtfTable();
  renderAlertList();
  renderAlertBanner();
  renderCharts();
}

function renderSummaryCards() {
  const { totalValue, totalCost, totalPnl, todayPnl, totalPct, todayPct } = calcPortfolioSummary();
  const divTotal = calcDividendTotal();
  const pct = Math.min((divTotal / DIVIDEND_GOAL) * 100, 100);

  setText('card-total-value', fmtMoney(totalValue));
  setText('card-cost',        '成本 ' + fmtMoney(totalCost));
  setHtml('card-today-pnl',   `<span class="${pnlClass(todayPnl)}">${fmtMoney(todayPnl)}</span>`);
  setHtml('card-today-pct',   `<span class="${changeClass(todayPct)}">${fmtPct(todayPct)}</span>`);
  setHtml('card-total-pnl',   `<span class="${pnlClass(totalPnl)}">${fmtMoney(totalPnl)}</span>`);
  setHtml('card-total-pct',   `<span class="${changeClass(totalPct)}">${fmtPct(totalPct)}</span>`);
  setText('card-div-total',   fmtMoney(divTotal));
  setText('card-div-remaining', `还差 ${fmtMoney(DIVIDEND_GOAL - divTotal)}`);
  document.getElementById('div-progress-bar').style.width = pct.toFixed(1) + '%';

  const { total: estDiv, count: estCount } = calcEstimatedAnnualDiv();
  setText('card-est-div', estCount > 0 ? fmtMoney(estDiv) : '¥ --');
  setText('card-est-div-sub', estCount > 0 ? `${estCount} 只股票已设置预期股息` : '编辑持仓可设置预期股息');
}

function renderPortfolioTable() {
  const tbody = document.getElementById('portfolio-tbody');
  if (!portfolio.length) {
    tbody.innerHTML = '<tr id="empty-row"><td colspan="10" class="empty-hint">暂无持仓，点击右上角「添加股票」开始追踪</td></tr>';
    return;
  }
  tbody.innerHTML = portfolio.map(pos => {
    const info    = stockData[pos.code];
    const name    = info?.name || pos.name || pos.code;
    const price   = info?.current ?? '--';
    const pct     = info?.changePct ?? null;
    const value   = info ? info.current * pos.shares : null;
    const cost    = pos.costPrice * pos.shares;
    const pnl     = value != null ? value - cost : null;
    const pnlPct  = cost > 0 && pnl != null ? (pnl / cost) * 100 : null;
    const todayPnl = info ? (info.current - info.prevClose) * pos.shares : null;
    let divYield = info ? calcAnnualDivYield(pos.code, info.current, pos.shares) : null;
    // Fallback: estimate yield from expectedDivPerShare when no historical records exist
    if (divYield == null && pos.expectedDivPerShare != null && info?.current) {
      divYield = (pos.expectedDivPerShare / info.current) * 100;
    }
    const estAnnual = pos.expectedDivPerShare != null
      ? pos.expectedDivPerShare * pos.shares * (pos.expectedTaxRate ?? 1.0)
      : null;

    const pa = priceAlerts[pos.code];
    const alertTag = pa && (pa.lower != null || pa.upper != null)
      ? `<span class="alert-tag" title="下限¥${pa.lower ?? '--'} / 上限¥${pa.upper ?? '--'}">⚑</span>`
      : '';

    let rowClass = '';
    if (info && Math.abs(info.changePct) >= ALERT_THRESHOLD) {
      rowClass = info.changePct > 0 ? 'row-alert-up' : 'row-alert-down';
    }

    return `<tr class="${rowClass}">
      <td>
        <div class="stock-name">${name} ${alertTag}</div>
        <div class="stock-code">${pos.code.toUpperCase()}</div>
      </td>
      <td class="num">${price !== '--' ? fmtPrice(price) : '--'}</td>
      <td class="num ${changeClass(pct)}">${fmtPct(pct)}</td>
      <td class="num">${pos.shares.toLocaleString()}</td>
      <td class="num">${fmtPrice(pos.costPrice)}</td>
      <td class="num">${value != null ? fmtMoney(value) : '--'}</td>
      <td class="num ${pnlClass(pnl)}">${pnl != null ? fmtMoney(pnl) + '<br><small>' + fmtPct(pnlPct) + '</small>' : '--'}</td>
      <td class="num ${pnlClass(todayPnl)}">${todayPnl != null ? fmtMoney(todayPnl) : '--'}</td>
      <td class="num">${divYield != null ? `<span class="div-yield">${fmt(divYield)}%</span>` : '<span class="text-muted">--</span>'}</td>
      <td class="num">${estAnnual != null ? `<span class="div-yield">${fmtMoney(estAnnual)}</span>` : '<span class="text-muted">--</span>'}</td>
      <td class="action-cell">
        <div class="action-btns">
          <button class="btn btn-ghost btn-xs" onclick="app.openEditStock('${pos.id}')">编辑</button>
          <button class="btn btn-ghost btn-xs" onclick="app.openSetAlert('${pos.code}', '${name}')">预警</button>
          <button class="btn btn-danger btn-xs" onclick="app.removeStock('${pos.id}')">删除</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderDividendTable() {
  const tbody = document.getElementById('dividend-tbody');
  if (!dividends.length) {
    tbody.innerHTML = '<tr id="div-empty-row"><td colspan="6" class="empty-hint">暂无股息记录</td></tr>';
    return;
  }
  tbody.innerHTML = [...dividends].sort((a, b) => b.date.localeCompare(a.date)).map(d => `
    <tr>
      <td><div class="stock-name">${d.name || d.code}</div><div class="stock-code">${d.code.toUpperCase()}</div></td>
      <td class="num">${d.date}</td>
      <td class="num">${fmt(d.perShare, 4)}</td>
      <td class="num">${d.shares.toLocaleString()}</td>
      <td class="num pnl-positive">${fmtMoney(d.total)}</td>
      <td><button class="btn btn-danger btn-xs" onclick="app.removeDividend('${d.id}')">删除</button></td>
    </tr>`).join('');
}

function renderAlertList() {
  const el = document.getElementById('alert-list');
  if (!alertLog.length) {
    el.innerHTML = '<p class="empty-hint">暂无预警触发记录</p>';
    return;
  }
  el.innerHTML = alertLog.slice(0, 50).map(a => `
    <div class="alert-item ${a.type}">
      <span class="ai-name">${a.name}</span>
      <span class="stock-code">${a.code.toUpperCase()}</span>
      <span class="ai-pct ${changeClass(a.changePct)}">${fmtPct(a.changePct)}</span>
      <span>现价 ¥${fmt(a.price)}</span>
      ${a.customAlert ? `<span class="custom-alert-badge">${a.customAlert}</span>` : ''}
      <span class="ai-time">${a.time}</span>
    </div>`).join('');
}

function renderAlertBanner() {
  const banner = document.getElementById('alert-banner');
  const today = todayStr();
  const todayAlerts = alertLog.filter(a => a.time.startsWith(today));
  if (!todayAlerts.length) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  banner.innerHTML = '⚠️ <strong>今日预警：</strong> ' + todayAlerts.slice(0, 6).map(a =>
    `${a.name} <strong class="${changeClass(a.changePct)}">${fmtPct(a.changePct)}</strong>`
  ).join(' &nbsp;·&nbsp; ');
}

// ─── Charts ───────────────────────────────
function renderCharts() {
  renderPieChart();
  renderDivChart();
  renderNavChart();
}

function renderPieChart() {
  const ctx = document.getElementById('chart-pie').getContext('2d');
  const items = portfolio.map(p => {
    const info  = stockData[p.code];
    const value = info ? info.current * p.shares : p.costPrice * p.shares;
    return { label: info?.name || p.name || p.code, value };
  }).filter(i => i.value > 0).sort((a, b) => b.value - a.value);

  const COLORS = ['#CF6830','#E8883A','#1D7D4F','#B07D2E','#3D7CC9','#8B5CF6','#C23B35','#2D9E7A'];
  if (charts.pie) charts.pie.destroy();
  charts.pie = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: items.map(i => i.label),
      datasets: [{ data: items.map(i => i.value), backgroundColor: COLORS, borderWidth: 0, borderRadius: 5 }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ¥ ${fmt(ctx.raw)}` } },
      },
      scales: {
        x: { grid: { color: 'rgba(28,23,20,.06)' }, ticks: { color: '#8C8078', font: { size: 10 }, callback: v => '¥' + (v / 10000).toFixed(1) + 'w' } },
        y: { grid: { display: false }, ticks: { color: '#4A4440', font: { size: 11 } } },
      },
    },
  });
}

function renderDivChart() {
  const ctx = document.getElementById('chart-div').getContext('2d');
  const monthly = {};
  for (const d of dividends) {
    const key = d.date.slice(0, 7);
    monthly[key] = (monthly[key] || 0) + d.total;
  }
  const labels = [], values = [];
  const now = nowBJ();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    labels.push(key.slice(5) + '月');
    values.push(monthly[key] || 0);
  }
  if (charts.div) charts.div.destroy();
  charts.div = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: '税后股息 (¥)', data: values, backgroundColor: 'rgba(207,104,48,.7)', borderColor: '#CF6830', borderWidth: 0, borderRadius: 5 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ¥ ${fmt(ctx.raw)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#8C8078', font: { size: 10 } } },
        y: { grid: { color: 'rgba(28,23,20,.06)' }, ticks: { color: '#8C8078', font: { size: 10 }, callback: v => '¥' + v.toLocaleString() } },
      },
    },
  });
}

function renderNavChart() {
  const ctx = document.getElementById('chart-nav').getContext('2d');
  if (!navHistory.length) {
    if (charts.nav) { charts.nav.destroy(); charts.nav = null; }
    return;
  }
  const labels = navHistory.map(n => n.date.slice(5));
  const values = navHistory.map(n => n.value);
  const costs  = navHistory.map(n => n.cost);
  if (charts.nav) charts.nav.destroy();
  charts.nav = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '持仓市值', data: values, borderColor: '#CF6830', backgroundColor: 'rgba(207,104,48,.08)', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: true, tension: 0.4 },
        { label: '持仓成本', data: costs,  borderColor: '#D5CAC0', backgroundColor: 'transparent',          borderWidth: 1, pointRadius: 0, borderDash: [4, 4], tension: 0.4 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8C8078', font: { size: 11 }, boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ¥ ${fmt(ctx.raw)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#8C8078', font: { size: 10 }, maxTicksLimit: 12 } },
        y: { grid: { color: 'rgba(28,23,20,.05)' }, ticks: { color: '#8C8078', font: { size: 10 }, callback: v => '¥' + (v / 10000).toFixed(1) + 'w' } },
      },
    },
  });
}

// ─── Modal helpers ────────────────────────
function openModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function setHtml(id, v) { const el = document.getElementById(id); if (el) el.innerHTML = v; }

// ─── Stock Search / Autocomplete ─────────
let _searchTimer = null;
let _searchResults = [];
let _searchActiveIdx = -1;

function onStockSearch(val) {
  // Clear previously selected stock when user changes the input
  document.getElementById('inp-code').value = '';
  document.getElementById('selected-stock-badge').classList.add('hidden');

  clearTimeout(_searchTimer);
  const q = val.trim();
  if (!q) { closeSearchDropdown(); return; }

  // If it already looks like a valid code, no need to search
  if (/^(sh|sz)?\d{6}$/.test(q.replace(/\s/g, ''))) {
    closeSearchDropdown();
    return;
  }

  _searchTimer = setTimeout(() => doSearch(q), 280);
}

async function doSearch(q) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    _searchResults = await res.json();
    renderSearchDropdown();
  } catch { closeSearchDropdown(); }
}

function renderSearchDropdown() {
  const dd = document.getElementById('search-dropdown');
  if (!_searchResults.length) { closeSearchDropdown(); return; }
  _searchActiveIdx = -1;
  dd.innerHTML = _searchResults.map((r, i) =>
    `<div class="search-item" data-idx="${i}" onmousedown="app.selectSearchResult(${i})">
      <span class="si-name">${r.name}</span>
      <span class="si-code">${r.code.toUpperCase()}</span>
    </div>`
  ).join('');
  dd.classList.remove('hidden');
}

function closeSearchDropdown() {
  document.getElementById('search-dropdown').classList.add('hidden');
  _searchResults = [];
  _searchActiveIdx = -1;
}

function selectSearchResult(idx) {
  const r = _searchResults[idx];
  if (!r) return;
  document.getElementById('inp-search-stock').value = r.name;
  document.getElementById('inp-code').value = r.code;
  const badge = document.getElementById('selected-stock-badge');
  badge.textContent = `✓ ${r.name}  ${r.code.toUpperCase()}`;
  badge.classList.remove('hidden');
  closeSearchDropdown();
}

function onSearchKeydown(e) {
  const dd = document.getElementById('search-dropdown');
  if (dd.classList.contains('hidden')) return;
  const items = dd.querySelectorAll('.search-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _searchActiveIdx = Math.min(_searchActiveIdx + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _searchActiveIdx = Math.max(_searchActiveIdx - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (_searchActiveIdx >= 0) selectSearchResult(_searchActiveIdx);
    return;
  } else if (e.key === 'Escape') {
    closeSearchDropdown(); return;
  }
  items.forEach((el, i) => el.classList.toggle('active', i === _searchActiveIdx));
}

// ─── Add Stock ────────────────────────────
function openAddStock() {
  document.getElementById('add-stock-error').classList.add('hidden');
  document.getElementById('inp-search-stock').value = '';
  document.getElementById('inp-code').value = '';
  document.getElementById('selected-stock-badge').classList.add('hidden');
  closeSearchDropdown();
  openModal('modal-add-stock');
  document.getElementById('inp-search-stock').focus();
}

async function addStock() {
  // Support both: selected from dropdown (inp-code hidden field) or typed directly
  const hiddenCode  = document.getElementById('inp-code').value.trim();
  const searchInput = document.getElementById('inp-search-stock').value.trim();
  const rawCode     = hiddenCode || searchInput;
  const shares      = parseInt(document.getElementById('inp-shares').value);
  const costPrice   = parseFloat(document.getElementById('inp-cost').value);
  const errEl       = document.getElementById('add-stock-error');
  errEl.classList.add('hidden');

  const code = normalizeCode(rawCode);
  if (!code)                        return showError(errEl, '请搜索并选择股票，或直接输入6位代码（如 600519）');
  if (!shares || shares <= 0)       return showError(errEl, '请输入有效的持股数量');
  if (!costPrice || costPrice <= 0) return showError(errEl, '请输入有效的买入均价');
  if (portfolio.some(p => p.code === code)) return showError(errEl, '该股票已在持仓中，请直接编辑');

  let name = '';
  try {
    const res = await fetch(`/api/stocks?codes=${code}`);
    const data = await res.json();
    name = data[code]?.name || '';
    if (!name && !data[code]) return showError(errEl, '无法获取该股票数据，请确认代码正确');
  } catch { /* name stays empty */ }

  portfolio.push({ id: uid(), code, name, shares, costPrice });
  saveState();
  closeModal('modal-add-stock');
  ['inp-code','inp-shares','inp-cost','inp-search-stock'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('selected-stock-badge').classList.add('hidden');
  showToast(`已添加 ${name || code}`, 'info');
  await fetchStockData();
}

function removeStock(id) {
  if (!confirm('确认删除该持仓？')) return;
  portfolio = portfolio.filter(p => p.id !== id);
  saveState();
  renderAll();
}

function showError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }

// ─── Edit Stock ───────────────────────────
function openEditStock(id) {
  const pos = portfolio.find(p => p.id === id);
  if (!pos) return;
  document.getElementById('edit-stock-id').value    = id;
  document.getElementById('edit-stock-title').textContent = `编辑持仓 — ${pos.name || pos.code}`;
  document.getElementById('inp-edit-shares').value        = pos.shares;
  document.getElementById('inp-edit-cost').value          = pos.costPrice;
  document.getElementById('inp-edit-expected-div').value  = pos.expectedDivPerShare ?? '';
  document.getElementById('inp-edit-tax-rate').value      = pos.expectedTaxRate ?? '1.0';
  document.getElementById('edit-stock-error').classList.add('hidden');
  openModal('modal-edit-stock');
}

async function fetchExpectedDiv() {
  const id  = document.getElementById('edit-stock-id').value;
  const pos = portfolio.find(p => p.id === id);
  if (!pos) return;

  const btn  = document.getElementById('btn-fetch-div');
  const hint = document.getElementById('div-fetch-hint');
  btn.disabled = true;
  btn.textContent = '获取中…';
  hint.classList.add('hidden');

  try {
    const res  = await fetch(`/api/dividend/${pos.code}`);
    const data = await res.json();
    if (data.perShare != null) {
      document.getElementById('inp-edit-expected-div').value = data.perShare;
      // Immediately persist so the table/card update without needing "保存"
      pos.expectedDivPerShare = data.perShare;
      const taxRate = parseFloat(document.getElementById('inp-edit-tax-rate').value) || 1.0;
      pos.expectedTaxRate = taxRate;

      // Auto-import dividend records for each distribution not already recorded
      let imported = 0;
      if (data.distributions && data.distributions.length) {
        for (const dist of data.distributions) {
          const exists = dividends.some(d => d.code === pos.code && d.date === dist.date);
          if (!exists) {
            dividends.push({
              id: uid(), code: pos.code, name: pos.name || pos.code,
              date: dist.date, perShare: dist.perShare, shares: pos.shares,
              taxRate, total: parseFloat((dist.perShare * pos.shares * taxRate).toFixed(2)),
            });
            imported++;
          }
        }
      }

      saveState();
      renderAll();
      const importNote = imported > 0 ? `，已导入 ${imported} 条股息记录` : '';
      const label = data.count > 1
        ? `近12个月共 ${data.count} 次分红，合计每股 ¥${data.perShare}（已自动保存${importNote}）`
        : `最近除权日 ${data.latestDate}，每股 ¥${data.perShare}（已自动保存${importNote}）`;
      hint.textContent = label;
      hint.className = 'fetch-hint ok';
    } else {
      hint.textContent = '未查到分红记录';
      hint.className = 'fetch-hint warn';
    }
  } catch {
    hint.textContent = '获取失败，请手动填写';
    hint.className = 'fetch-hint warn';
  } finally {
    btn.disabled = false;
    btn.textContent = '自动获取';
  }
}

function saveEditStock() {
  const id        = document.getElementById('edit-stock-id').value;
  const shares    = parseInt(document.getElementById('inp-edit-shares').value);
  const costPrice = parseFloat(document.getElementById('inp-edit-cost').value);
  const errEl     = document.getElementById('edit-stock-error');
  errEl.classList.add('hidden');

  if (!shares || shares <= 0)       return showError(errEl, '请输入有效的持股数量');
  if (!costPrice || costPrice <= 0) return showError(errEl, '请输入有效的买入均价');

  const pos = portfolio.find(p => p.id === id);
  if (!pos) return;
  pos.shares = shares;
  pos.costPrice = costPrice;
  const rawExpected = document.getElementById('inp-edit-expected-div').value;
  pos.expectedDivPerShare = rawExpected !== '' ? parseFloat(rawExpected) : null;
  pos.expectedTaxRate     = parseFloat(document.getElementById('inp-edit-tax-rate').value);
  saveState();
  closeModal('modal-edit-stock');
  showToast(`已更新 ${pos.name || pos.code}`, 'info');
  renderAll();
}

// ─── Price Alert Settings ─────────────────
function openSetAlert(code, name) {
  document.getElementById('alert-stock-code').value = code;
  document.getElementById('alert-stock-title').textContent = `设置预警价 — ${name}`;
  const pa = priceAlerts[code] || {};
  document.getElementById('inp-alert-lower').value = pa.lower ?? '';
  document.getElementById('inp-alert-upper').value = pa.upper ?? '';
  openModal('modal-set-alert');
}

function saveSetAlert() {
  const code  = document.getElementById('alert-stock-code').value;
  const lower = document.getElementById('inp-alert-lower').value;
  const upper = document.getElementById('inp-alert-upper').value;
  const lv    = lower !== '' ? parseFloat(lower) : null;
  const uv    = upper !== '' ? parseFloat(upper) : null;

  if (lv !== null && uv !== null && lv >= uv) {
    showToast('下限价必须小于上限价', 'error'); return;
  }
  if (lv !== null && isNaN(lv)) { showToast('请输入有效的下限价', 'error'); return; }
  if (uv !== null && isNaN(uv)) { showToast('请输入有效的上限价', 'error'); return; }

  if (lv == null && uv == null) {
    delete priceAlerts[code];
  } else {
    priceAlerts[code] = { lower: lv, upper: uv };
  }
  saveState();
  closeModal('modal-set-alert');
  showToast('预警价已保存', 'info');
  renderPortfolioTable();
}

function clearStockAlert(code) {
  delete priceAlerts[code];
  saveState();
  document.getElementById('inp-alert-lower').value = '';
  document.getElementById('inp-alert-upper').value = '';
  showToast('预警已清除', 'info');
}

// ─── Add Dividend ─────────────────────────
function openAddDividend() {
  if (!portfolio.length) { showToast('请先添加持仓股票', 'error'); return; }
  const sel = document.getElementById('inp-div-code');
  sel.innerHTML = portfolio.map(p =>
    `<option value="${p.code}">${p.name || p.code} (${p.code.toUpperCase()})</option>`
  ).join('');
  sel.onchange = () => {
    const pos = portfolio.find(p => p.code === sel.value);
    if (pos) document.getElementById('inp-div-shares').value = pos.shares;
  };
  sel.dispatchEvent(new Event('change'));
  document.getElementById('inp-div-date').value = todayStr();
  openModal('modal-add-dividend');
}

function addDividend() {
  const code     = document.getElementById('inp-div-code').value;
  const date     = document.getElementById('inp-div-date').value;
  const perShare = parseFloat(document.getElementById('inp-div-per-share').value);
  const shares   = parseInt(document.getElementById('inp-div-shares').value);
  const taxRate  = parseFloat(document.getElementById('inp-div-tax').value);

  if (!date || !perShare || !shares) { showToast('请填写完整股息信息', 'error'); return; }

  const pos   = portfolio.find(p => p.code === code);
  const name  = pos?.name || code;
  const total = parseFloat((perShare * shares * taxRate).toFixed(2));

  dividends.push({ id: uid(), code, name, date, perShare, shares, taxRate, total });
  saveState();
  closeModal('modal-add-dividend');
  showToast(`已录入 ${name} 股息 ${fmtMoney(total)}`, 'info');
  renderAll();
}

function removeDividend(id) {
  dividends = dividends.filter(d => d.id !== id);
  saveState();
  renderAll();
}

// ─── Import / Export ──────────────────────
function exportPortfolioCSV() {
  const rows = [
    ['代码', '名称', '持股数', '买入均价'],
    ...portfolio.map(p => [p.code, p.name || '', p.shares, p.costPrice]),
  ];
  downloadCSV(rows, `持仓数据_${todayStr()}.csv`);
}

function exportDividendsCSV() {
  const rows = [
    ['代码', '名称', '除权日', '每股股息', '持股数', '税率', '税后合计'],
    ...dividends.map(d => [d.code, d.name || '', d.date, d.perShare, d.shares, d.taxRate, d.total]),
  ];
  downloadCSV(rows, `股息记录_${todayStr()}.csv`);
}

function downloadCSV(rows, filename) {
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function triggerImport(type) {
  const input = document.getElementById('import-file-input');
  input.dataset.type = type;
  input.value = '';
  input.click();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('import-file-input').addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    const type = this.dataset.type;
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result.replace(/^\uFEFF/, '');
      const lines = text.split(/\r?\n/);
      const dataLines = lines.slice(1).filter(l => l.trim());
      let added = 0, skipped = 0;

      if (type === 'portfolio') {
        // 代码,名称,持股数,买入均价
        for (const line of dataLines) {
          const cols = parseCSVLine(line);
          if (cols.length < 4) continue;
          const code = normalizeCode(cols[0]);
          if (!code) { skipped++; continue; }
          if (portfolio.some(p => p.code === code)) { skipped++; continue; }
          const shares = parseInt(cols[2]);
          const costPrice = parseFloat(cols[3]);
          if (!shares || !costPrice) { skipped++; continue; }
          portfolio.push({ id: uid(), code, name: cols[1] || '', shares, costPrice });
          added++;
        }
        saveState();
        showToast(`持仓导入完成：新增 ${added} 条，跳过 ${skipped} 条`, 'info');
        fetchStockData();
      } else if (type === 'dividends') {
        // 代码,名称,除权日,每股股息,持股数,税率,税后合计
        for (const line of dataLines) {
          const cols = parseCSVLine(line);
          if (cols.length < 6) continue;
          const code = normalizeCode(cols[0]);
          if (!code) { skipped++; continue; }
          const date = cols[2], perShare = parseFloat(cols[3]);
          const shares = parseInt(cols[4]), taxRate = parseFloat(cols[5]);
          const total = cols[6] ? parseFloat(cols[6]) : parseFloat((perShare * shares * taxRate).toFixed(2));
          if (!date || !perShare || !shares) { skipped++; continue; }
          dividends.push({ id: uid(), code, name: cols[1] || code, date, perShare, shares, taxRate, total });
          added++;
        }
        saveState();
        showToast(`股息导入完成：新增 ${added} 条，跳过 ${skipped} 条`, 'info');
        renderAll();
      }
    };
    reader.readAsText(file, 'utf-8');
  });
});

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { cur += c; }
    } else {
      if (c === '"') { inQuote = true; }
      else if (c === ',') { result.push(cur.trim()); cur = ''; }
      else { cur += c; }
    }
  }
  result.push(cur.trim());
  return result;
}

// ─── Watchlist ────────────────────────────
let _watchSearchTimer = null;
let _watchSearchResults = [];
let _watchSearchActiveIdx = -1;

function renderWatchlistTable() {
  const tbody = document.getElementById('watchlist-tbody');
  const totalEl = document.getElementById('watchlist-est-total');
  if (!watchlist.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-hint">暂无关注股票，点击「添加关注」开始</td></tr>';
    totalEl.classList.add('hidden');
    return;
  }
  let totalEst = 0;
  tbody.innerHTML = watchlist.map(w => {
    const info = stockData[w.code];
    const price = info?.current ?? null;
    const pct   = info?.changePct ?? null;
    const div   = w.expectedDivPerShare;
    const divYield  = price && div ? (div / price * 100) : null;
    const estDiv    = div && w.simShares ? div * w.simShares : null;
    const simAsset  = price && w.simShares ? price * w.simShares : null;
    if (estDiv) totalEst += estDiv;
    return `<tr>
      <td>
        <div class="stock-name">${w.name || w.code}</div>
        <div class="stock-code">${w.code.toUpperCase()}</div>
      </td>
      <td class="num">${price ? fmtPrice(price) : '--'}</td>
      <td class="num ${changeClass(pct)}">${fmtPct(pct)}</td>
      <td class="num">${div ? fmtPrice(div, 4) : '--'}</td>
      <td class="num">${divYield != null ? `<span class="div-yield">${fmt(divYield)}%</span>` : '--'}</td>
      <td class="num">
        <input type="number" class="inline-input" value="${w.simShares || ''}"
          placeholder="输入股数" min="100" step="100"
          onchange="app.updateWatchShares('${w.id}', this.value)">
      </td>
      <td class="num">${simAsset != null ? fmtMoney(simAsset) : '--'}</td>
      <td class="num">${estDiv != null ? fmtMoney(estDiv) : '--'}</td>
      <td class="action-cell">
        <div class="action-btns">
          <button class="btn btn-ghost btn-xs" onclick="app.fetchWatchDiv('${w.id}')">${div ? '刷新股息' : '获取股息'}</button>
          <button class="btn btn-danger btn-xs" onclick="app.removeWatch('${w.id}')">删除</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  if (totalEst > 0) {
    totalEl.textContent = `模拟持股预估年股息（税前）合计：${fmtMoney(totalEst)}`;
    totalEl.classList.remove('hidden');
  } else {
    totalEl.classList.add('hidden');
  }
}

function openAddWatch() {
  document.getElementById('add-watch-error').classList.add('hidden');
  document.getElementById('inp-search-watch').value = '';
  document.getElementById('inp-watch-code').value = '';
  document.getElementById('watch-selected-badge').classList.add('hidden');
  closeWatchDropdown();
  openModal('modal-add-watch');
  document.getElementById('inp-search-watch').focus();
}

async function addWatch() {
  const hiddenCode  = document.getElementById('inp-watch-code').value.trim();
  const searchInput = document.getElementById('inp-search-watch').value.trim();
  const rawCode     = hiddenCode || searchInput;
  const errEl       = document.getElementById('add-watch-error');
  errEl.classList.add('hidden');

  const code = normalizeCode(rawCode);
  if (!code) return showError(errEl, '请搜索并选择股票，或直接输入6位代码（如 600519）');
  if (watchlist.some(w => w.code === code)) return showError(errEl, '该股票已在关注列表中');

  let name = '';
  try {
    const res = await fetch(`/api/stocks?codes=${code}`);
    const data = await res.json();
    name = data[code]?.name || '';
  } catch { /* name stays empty */ }

  const newItem = { id: uid(), code, name, expectedDivPerShare: null, simShares: null };
  watchlist.push(newItem);
  saveState();
  closeModal('modal-add-watch');
  ['inp-watch-code', 'inp-search-watch'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('watch-selected-badge').classList.add('hidden');
  showToast(`已添加 ${name || code}，正在获取股息…`, 'info');

  // Auto-fetch dividend
  try {
    const res = await fetch(`/api/dividend/${code}`);
    const data = await res.json();
    if (data.perShare != null) {
      newItem.expectedDivPerShare = data.perShare;
      saveState();
      showToast(`${name || code} 股息已获取：每股 ¥${data.perShare}`, 'info');
    }
  } catch { /* silent */ }

  await fetchStockData();
}

async function fetchWatchDiv(id) {
  const w = watchlist.find(w => w.id === id);
  if (!w) return;
  try {
    const res = await fetch(`/api/dividend/${w.code}`);
    const data = await res.json();
    if (data.perShare != null) {
      w.expectedDivPerShare = data.perShare;
      saveState();
      renderWatchlistTable();
      showToast(`${w.name || w.code} 股息已更新：每股 ¥${data.perShare}`, 'info');
    } else {
      showToast(`${w.name || w.code} 未查到分红记录`, 'info');
    }
  } catch {
    showToast('获取股息失败', 'error');
  }
}

function removeWatch(id) {
  if (!confirm('确认从关注列表移除？')) return;
  watchlist = watchlist.filter(w => w.id !== id);
  saveState();
  renderWatchlistTable();
}

function updateWatchShares(id, val) {
  const w = watchlist.find(w => w.id === id);
  if (!w) return;
  w.simShares = parseInt(val) || null;
  saveState();
  renderWatchlistTable();
}

function onWatchSearch(val) {
  document.getElementById('inp-watch-code').value = '';
  document.getElementById('watch-selected-badge').classList.add('hidden');
  clearTimeout(_watchSearchTimer);
  const q = val.trim();
  if (!q) { closeWatchDropdown(); return; }
  if (/^(sh|sz)?\d{6}$/.test(q.replace(/\s/g, ''))) { closeWatchDropdown(); return; }
  _watchSearchTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      _watchSearchResults = await res.json();
      renderWatchDropdown();
    } catch { closeWatchDropdown(); }
  }, 280);
}

function renderWatchDropdown() {
  const dd = document.getElementById('watch-search-dropdown');
  if (!_watchSearchResults.length) { closeWatchDropdown(); return; }
  _watchSearchActiveIdx = -1;
  dd.innerHTML = _watchSearchResults.map((r, i) =>
    `<div class="search-item" data-idx="${i}" onmousedown="app.selectWatchResult(${i})">
      <span class="si-name">${r.name}</span>
      <span class="si-code">${r.code.toUpperCase()}</span>
    </div>`
  ).join('');
  dd.classList.remove('hidden');
}

function closeWatchDropdown() {
  document.getElementById('watch-search-dropdown').classList.add('hidden');
  _watchSearchResults = [];
  _watchSearchActiveIdx = -1;
}

function selectWatchResult(idx) {
  const r = _watchSearchResults[idx];
  if (!r) return;
  document.getElementById('inp-search-watch').value = r.name;
  document.getElementById('inp-watch-code').value = r.code;
  const badge = document.getElementById('watch-selected-badge');
  badge.textContent = `✓ ${r.name}  ${r.code.toUpperCase()}`;
  badge.classList.remove('hidden');
  closeWatchDropdown();
}

function onWatchKeydown(e) {
  const dd = document.getElementById('watch-search-dropdown');
  if (dd.classList.contains('hidden')) return;
  const items = dd.querySelectorAll('.search-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _watchSearchActiveIdx = Math.min(_watchSearchActiveIdx + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _watchSearchActiveIdx = Math.max(_watchSearchActiveIdx - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (_watchSearchActiveIdx >= 0) selectWatchResult(_watchSearchActiveIdx);
    return;
  } else if (e.key === 'Escape') {
    closeWatchDropdown();
  }
  items.forEach((el, i) => el.classList.toggle('active', i === _watchSearchActiveIdx));
}

// ─── ETF List ─────────────────────────────
let _etfSearchTimer = null;
let _etfSearchResults = [];
let _etfSearchActiveIdx = -1;

function renderEtfTable() {
  const tbody = document.getElementById('etf-tbody');
  const totalEl = document.getElementById('etf-est-total');
  if (!etfList.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-hint">暂无ETF，点击「添加ETF」开始</td></tr>';
    totalEl.classList.add('hidden');
    return;
  }
  let totalEst = 0;
  tbody.innerHTML = etfList.map(e => {
    const info = stockData[e.code];
    const price = info?.current ?? null;
    const pct   = info?.changePct ?? null;
    const div   = e.divPerUnit;
    const divYield = price && div ? (div / price * 100) : null;
    const simAsset = price && e.simUnits ? price * e.simUnits : null;
    const estDiv   = div && e.simUnits ? div * e.simUnits : null;
    if (estDiv) totalEst += estDiv;
    return `<tr>
      <td>
        <div class="stock-name">${e.name || e.code}</div>
        <div class="stock-code">${e.code.toUpperCase()}</div>
      </td>
      <td class="num">${price ? fmtPrice(price) : '--'}</td>
      <td class="num ${changeClass(pct)}">${fmtPct(pct)}</td>
      <td class="num">
        <input type="number" class="inline-input" value="${div || ''}"
          placeholder="每份分红" step="0.0001" min="0"
          onchange="app.updateEtfDiv('${e.id}', this.value)">
      </td>
      <td class="num">${divYield != null ? `<span class="div-yield">${fmt(divYield)}%</span>` : '--'}</td>
      <td class="num">
        <input type="number" class="inline-input" value="${e.simUnits || ''}"
          placeholder="份数" min="100" step="100"
          onchange="app.updateEtfUnits('${e.id}', this.value)">
      </td>
      <td class="num">${simAsset != null ? fmtMoney(simAsset) : '--'}</td>
      <td class="num">${estDiv != null ? fmtMoney(estDiv) : '--'}</td>
      <td class="action-cell">
        <div class="action-btns">
          <button class="btn btn-ghost btn-xs" onclick="app.fetchEtfDiv('${e.id}')">${div ? '刷新分红' : '获取分红'}</button>
          <button class="btn btn-danger btn-xs" onclick="app.removeEtf('${e.id}')">删除</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  if (totalEst > 0) {
    totalEl.textContent = `模拟持有预估年分红合计：${fmtMoney(totalEst)}`;
    totalEl.classList.remove('hidden');
  } else {
    totalEl.classList.add('hidden');
  }
}

function openAddEtf() {
  document.getElementById('add-etf-error').classList.add('hidden');
  document.getElementById('inp-search-etf').value = '';
  document.getElementById('inp-etf-code').value = '';
  document.getElementById('etf-selected-badge').classList.add('hidden');
  closeEtfDropdown();
  openModal('modal-add-etf');
  document.getElementById('inp-search-etf').focus();
}

async function addEtf() {
  const hiddenCode  = document.getElementById('inp-etf-code').value.trim();
  const searchInput = document.getElementById('inp-search-etf').value.trim();
  const rawCode     = hiddenCode || searchInput;
  const errEl       = document.getElementById('add-etf-error');
  errEl.classList.add('hidden');

  const code = normalizeCode(rawCode);
  if (!code) return showError(errEl, '请搜索并选择ETF，或直接输入6位代码（如 510300）');
  if (etfList.some(e => e.code === code)) return showError(errEl, '该ETF已在列表中');

  let name = '';
  try {
    const res = await fetch(`/api/stocks?codes=${code}`);
    const data = await res.json();
    name = data[code]?.name || '';
  } catch { /* name stays empty */ }

  const newEtf = { id: uid(), code, name, divPerUnit: null, simUnits: null };
  etfList.push(newEtf);
  saveState();
  closeModal('modal-add-etf');
  showToast(`已添加 ${name || code}，正在获取分红数据…`, 'info');

  // Auto-fetch ETF dividend
  try {
    const res = await fetch(`/api/etf-dividend/${code}`);
    const data = await res.json();
    if (data.perShare != null) {
      newEtf.divPerUnit = data.perShare;
      saveState();
      showToast(`${name || code} 分红已获取：每份 ¥${data.perShare}`, 'info');
    }
  } catch { /* silent */ }

  await fetchStockData();
}

function removeEtf(id) {
  if (!confirm('确认从ETF列表移除？')) return;
  etfList = etfList.filter(e => e.id !== id);
  saveState();
  renderEtfTable();
}

async function fetchEtfDiv(id) {
  const e = etfList.find(e => e.id === id);
  if (!e) return;
  showToast(`正在获取 ${e.name || e.code} 分红数据…`, 'info', 2000);
  try {
    const res = await fetch(`/api/etf-dividend/${e.code}`);
    const data = await res.json();
    if (data.perShare != null) {
      e.divPerUnit = data.perShare;
      saveState();
      renderEtfTable();
      showToast(`${e.name || e.code} 分红已更新：每份 ¥${data.perShare}`, 'info');
    } else {
      showToast(`${e.name || e.code} 未查到分红记录，请手动填写`, 'info');
    }
  } catch {
    showToast('获取失败，请手动填写', 'error');
  }
}

function updateEtfDiv(id, val) {
  const e = etfList.find(e => e.id === id);
  if (!e) return;
  e.divPerUnit = parseFloat(val) || null;
  saveState();
  renderEtfTable();
}

function updateEtfUnits(id, val) {
  const e = etfList.find(e => e.id === id);
  if (!e) return;
  e.simUnits = parseInt(val) || null;
  saveState();
  renderEtfTable();
}

function onEtfSearch(val) {
  document.getElementById('inp-etf-code').value = '';
  document.getElementById('etf-selected-badge').classList.add('hidden');
  clearTimeout(_etfSearchTimer);
  const q = val.trim();
  if (!q) { closeEtfDropdown(); return; }
  if (/^(sh|sz)?\d{6}$/.test(q.replace(/\s/g, ''))) { closeEtfDropdown(); return; }
  _etfSearchTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      _etfSearchResults = await res.json();
      renderEtfDropdown();
    } catch { closeEtfDropdown(); }
  }, 280);
}

function renderEtfDropdown() {
  const dd = document.getElementById('etf-search-dropdown');
  if (!_etfSearchResults.length) { closeEtfDropdown(); return; }
  _etfSearchActiveIdx = -1;
  dd.innerHTML = _etfSearchResults.map((r, i) =>
    `<div class="search-item" data-idx="${i}" onmousedown="app.selectEtfResult(${i})">
      <span class="si-name">${r.name}</span>
      <span class="si-code">${r.code.toUpperCase()}</span>
    </div>`
  ).join('');
  dd.classList.remove('hidden');
}

function closeEtfDropdown() {
  document.getElementById('etf-search-dropdown').classList.add('hidden');
  _etfSearchResults = [];
  _etfSearchActiveIdx = -1;
}

function selectEtfResult(idx) {
  const r = _etfSearchResults[idx];
  if (!r) return;
  document.getElementById('inp-search-etf').value = r.name;
  document.getElementById('inp-etf-code').value = r.code;
  const badge = document.getElementById('etf-selected-badge');
  badge.textContent = `✓ ${r.name}  ${r.code.toUpperCase()}`;
  badge.classList.remove('hidden');
  closeEtfDropdown();
}

function onEtfKeydown(e) {
  const dd = document.getElementById('etf-search-dropdown');
  if (dd.classList.contains('hidden')) return;
  const items = dd.querySelectorAll('.search-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _etfSearchActiveIdx = Math.min(_etfSearchActiveIdx + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _etfSearchActiveIdx = Math.max(_etfSearchActiveIdx - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (_etfSearchActiveIdx >= 0) selectEtfResult(_etfSearchActiveIdx);
    return;
  } else if (e.key === 'Escape') {
    closeEtfDropdown();
  }
  items.forEach((el, i) => el.classList.toggle('active', i === _etfSearchActiveIdx));
}

// ─── Alert history clear ──────────────────
function clearAlerts() {
  if (!confirm('清除所有预警记录？')) return;
  alertLog = [];
  alreadyAlerted.clear();
  saveState();
  renderAll();
}

// ─── Toast ────────────────────────────────
function showToast(msg, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'fadeOut .3s forwards';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ─── Auto-refresh ─────────────────────────
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    await updateMarketStatus();
    const badge = document.getElementById('market-badge');
    if (badge.classList.contains('badge-open')) {
      await fetchStockData();
    }
  }, REFRESH_MS);
}

// ─── Public API ───────────────────────────
const app = {
  refresh:        () => { fetchStockData(); updateMarketStatus(); },
  openAddStock,
  addStock,
  removeStock,
  onStockSearch,
  onSearchKeydown,
  selectSearchResult,
  openEditStock,
  saveEditStock,
  fetchExpectedDiv,
  openSetAlert,
  saveSetAlert,
  clearStockAlert,
  openAddDividend,
  addDividend,
  removeDividend,
  clearAlerts,
  closeModal,
  exportPortfolioCSV,
  exportDividendsCSV,
  triggerImport,
  openAddWatch,
  addWatch,
  removeWatch,
  updateWatchShares,
  fetchWatchDiv,
  onWatchSearch,
  onWatchKeydown,
  selectWatchResult,
  openAddEtf,
  addEtf,
  removeEtf,
  fetchEtfDiv,
  updateEtfDiv,
  updateEtfUnits,
  onEtfSearch,
  onEtfKeydown,
  selectEtfResult,
};

// ─── Bootstrap ────────────────────────────
(async function init() {
  loadState();
  renderAll();
  await updateMarketStatus();
  await fetchStockData();
  startAutoRefresh();
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
})();
