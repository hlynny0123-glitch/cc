# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

```bash
npm install        # first time only
node server.js     # starts on http://localhost:3000
```

No build step, no tests, no linter. Restart the Node process after any `server.js` change. Frontend changes (`public/`) take effect on browser refresh with no restart. After editing `app.js`, bump the `?v=N` query string on the `<script src="app.js?v=N">` tag in `index.html` to bust the browser cache.

## Repository & Deployment

- **Gitee (code backup)**: `https://gitee.com/hlynny0123/cc` (private repo)
- **GitHub**: `https://github.com/hlynny0123-glitch/cc` (private repo)
- **Live site**: `http://124.223.101.230:3000` — 腾讯云轻量应用服务器，上海二区，2核2G，Node.js 镜像

### Push code changes (local → Gitee + GitHub)
```bash
git add .
git commit -m "描述改动"
git push origin master        # Gitee
git push github master        # GitHub
```

### Deploy updates to server
SSH into server via 腾讯云 OrcaTerm, then:
```bash
cd /root/cc
git pull
pm2 restart cc
```

### Server management
- pm2 keeps `server.js` running 24/7 and auto-restarts on crash
- To check status: `pm2 status`
- To view logs: `pm2 logs cc`

### Data persistence note
All user data (portfolio, dividends, watchlist, alerts) is stored in **browser localStorage only**. It does NOT sync between devices or browsers. To migrate data between browsers, use the export/import CSV feature, or copy localStorage via the browser console.

## Architecture

**Two-layer architecture: Express proxy + vanilla JS SPA.**

- `server.js` — Express backend. Sole purpose: proxy third-party APIs that block CORS or return GBK-encoded data. No database, no auth, no business logic.
- `public/` — Static frontend served by Express. Pure HTML/CSS/JS, no framework, no bundler.

All application state is stored exclusively in **`localStorage`**. There is no server-side persistence.

## Backend API Endpoints

| Route | Source | Notes |
|---|---|---|
| `GET /api/stocks?codes=sh600519,sz000001` | `hq.sinajs.cn` | Real-time A-share quotes. GBK-encoded response, decoded with `iconv-lite`. Returns a map of `code → {name, current, prevClose, open, high, low, change, changePct, volume, amount, date, time}`. |
| `GET /api/search?q=茅台` | `suggest3.sinajs.cn` | Stock name/code autocomplete. GBK-encoded. Response variable is named `suggestdata` (not `suggestvalue`). Fields per item: `[0]=shortname, [1]=type(11=SH/12=SZ), [2]=code6, [3]=exchange_code(sh600519), [4]=fullname`. Returns `[{name, code, type}]`. |
| `GET /api/market-status` | Local | Returns `{open: bool}` based on Beijing time (UTC+8). Market hours: 9:25–11:30 and 13:00–15:00 on weekdays. |
| `GET /api/dividend/:code` | `basic.10jqka.com.cn` | Per-share dividend history. Returns `{perShare, latestDate, count, distributions: [{perShare, date}]}`. See scraping note below. |

A simple in-memory `Map` cache with 10-second TTL is applied to `/api/stocks`.

## Frontend Structure (`public/app.js`)

All HTML `onclick` handlers call `app.functionName()`. The global `const app = {...}` object at the bottom of `app.js` is the only public API exposed to HTML. Never add functions directly to `onclick` without also exporting them via `app`.

**Module-level state** (all persisted to `localStorage` via `saveState()` / `loadState()`):
- `portfolio` — `{id, code, name, shares, costPrice, expectedDivPerShare, expectedTaxRate}`
- `dividends` — `{id, code, name, date, perShare, shares, taxRate, total}`
- `priceAlerts` — `{ [code]: {lower, upper} }` — custom upper/lower price thresholds per stock
- `navHistory` — `[{date, value, cost}]` — daily snapshots, max 365 entries, updated on each quote fetch
- `alertLog` — triggered alert history (both ±2% change alerts and custom price alerts)
- `alreadyAlerted` — persisted Set of alert keys already fired today; auto-cleared on new day
- `watchlist` — `{id, code, name, expectedDivPerShare, simShares}` — stocks under observation (not held)
- `stockData` — live quote cache (not persisted, rebuilt on each fetch)

**Rendering** is always full: `renderAll()` calls all sub-renderers. There is no partial/incremental update. Charts use Chart.js loaded from CDN — the TypeScript language server will flag `Chart` as unknown; this is a false positive.

**Stock search autocomplete**: used in both "添加股票" (portfolio) and "添加关注" (watchlist) modals. Both use the same `/api/search` endpoint but separate state variables (`_searchResults` / `_watchSearchResults`). On selection, the exchange-prefixed code is stored in a hidden input field and a confirmation badge is shown.

**Dividend auto-fetch flow**: clicking "自动获取" in the edit modal calls `/api/dividend/:code`, immediately saves `expectedDivPerShare` to the portfolio item, and auto-imports any new `distributions` entries into the `dividends` array (skipping duplicates by code+date). The user does not need to click "保存" for the fetch to take effect. Same logic applies when adding a watchlist stock — dividend is fetched automatically on add.

**Dividend estimate vs historical yield**:
- `预估年股息` column: `expectedDivPerShare × shares × expectedTaxRate` — forward-looking estimate.
- `年化股息率` column: calculated from actual `dividends` records in the last 12 months. Falls back to `expectedDivPerShare / currentPrice × 100` when no historical records exist.

**Price alert deduplication**: alert keys use the format `${todayStr()}_${code}_pct|upper|lower`. `alreadyAlerted` is persisted to localStorage and filtered to today's date on load. Each alert condition fires at most once per day per stock, surviving page reloads.

**`fetchStockData()`** fetches quotes for both `portfolio` and `watchlist` codes in one request.

## Page Sections

1. **Summary cards** — 总市值, 今日盈亏, 累计盈亏, 股息目标进度, 预估本年股息
2. **持仓明细** — portfolio table with columns: 代码/名称, 现价, 涨跌幅, 持仓股数, 成本价, 持仓市值, 浮动盈亏, 今日盈亏, 年化股息率, 预估年股息, 操作
3. **Charts row** — 持仓分布 (horizontal bar chart, sorted by value desc), 股息收入近12月 (bar)
4. **资产净值曲线** — line chart from navHistory
5. **关注列表** — watchlist table with columns: 代码/名称, 现价, 涨跌幅, 每股年股息, 股息率, 模拟持股数 (inline editable), 模拟总资产 (price × simShares), 预估年股息, 操作; bottom summary shows total simulated dividend
6. **股息记录** — historical dividend entries, import/export CSV
7. **预警记录** — alert log

## Stock Code Conventions

Exchange prefix is required everywhere internally: `sh` for Shanghai (6-digit codes starting with `6`), `sz` for Shenzhen (`0` or `3`). `normalizeCode()` exists in both `server.js` and `app.js` — keep them in sync.

## Dividend Auto-Fetch (`/api/dividend/:code`)

Scrapes `https://basic.10jqka.com.cn/{code6}/bonus.html` (GBK, same 6-digit code for both SH and SZ). The page server-renders dividend rows as `<tr class="J_pageritem">`. Only rows containing `实施方案` (completed distributions) are processed. The per-share amount is extracted from a cell matching `10派X元(含税)` (e.g. `10派239.57元` → ¥23.957/share). The ex-dividend date is the second-to-last `YYYY-MM-DD` value in the row's cells. Distributions within the last 12 months are collected into the `distributions` array and summed for `perShare`; if none qualify, the most recent single record is used as fallback.

**Do not attempt EastMoney's datacenter JSON API** (`datacenter.eastmoney.com/securities/api/data/v1/get`). All `reportName` values for dividend data return `{"success":false,"code":9501}`. This was extensively investigated and is a dead end.
