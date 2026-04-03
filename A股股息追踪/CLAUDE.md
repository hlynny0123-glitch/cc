# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

```bash
npm install        # first time only
node server.js     # starts on http://localhost:3000
```

No build step, no tests, no linter. Restart the Node process after any `server.js` change. Frontend changes (`public/`) take effect on browser refresh with no restart. After editing `app.js`, bump the `?v=N` query string on the `<script src="app.js?v=N">` tag in `index.html` to bust the browser cache.

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
- `stockData` — live quote cache (not persisted, rebuilt on each fetch)

**Rendering** is always full: `renderAll()` calls all sub-renderers. There is no partial/incremental update. Charts use Chart.js loaded from CDN — the TypeScript language server will flag `Chart` as unknown; this is a false positive.

**Stock search autocomplete**: `onStockSearch()` debounces 280ms then calls `/api/search`. Results render in `#search-dropdown`. On selection, `selectSearchResult()` stores the exchange-prefixed code in the hidden `#inp-code` field and shows a confirmation badge. `addStock()` reads from `#inp-code` first, falling back to the raw text in `#inp-search-stock` (which normalizeCode can handle if a plain 6-digit code was typed).

**Dividend auto-fetch flow**: clicking "自动获取" in the edit modal calls `/api/dividend/:code`, immediately saves `expectedDivPerShare` to the portfolio item, and auto-imports any new `distributions` entries into the `dividends` array (skipping duplicates by code+date). This means the user does not need to click "保存" for the dividend fetch to take effect.

**Dividend estimate vs historical yield**:
- `预估年股息` column: `expectedDivPerShare × shares × expectedTaxRate` — forward-looking estimate set via auto-fetch or manual input.
- `年化股息率` column: primarily calculated from actual `dividends` records in the last 12 months. Falls back to `expectedDivPerShare / currentPrice × 100` when no historical records exist.

**Price alert deduplication**: alert keys use the format `${todayStr()}_${code}_pct|upper|lower`. `alreadyAlerted` is persisted to localStorage and filtered to today's date on load. Each alert condition fires at most once per day per stock, surviving page reloads within the same day.

## Stock Code Conventions

Exchange prefix is required everywhere internally: `sh` for Shanghai (6-digit codes starting with `6`), `sz` for Shenzhen (`0` or `3`). `normalizeCode()` exists in both `server.js` and `app.js` — keep them in sync.

## Dividend Auto-Fetch (`/api/dividend/:code`)

Scrapes `https://basic.10jqka.com.cn/{code6}/bonus.html` (GBK, same 6-digit code for both SH and SZ). The page server-renders dividend rows as `<tr class="J_pageritem">`. Only rows containing `实施方案` (completed distributions) are processed. The per-share amount is extracted from a cell matching `10派X元(含税)` (e.g. `10派239.57元` → ¥23.957/share). The ex-dividend date is the second-to-last `YYYY-MM-DD` value in the row's cells. Distributions within the last 12 months are collected into the `distributions` array and summed for `perShare`; if none qualify, the most recent single record is used as fallback.

**Do not attempt EastMoney's datacenter JSON API** (`datacenter.eastmoney.com/securities/api/data/v1/get`). All `reportName` values for dividend data (`RPT_SHAREHOLDER_DIVIDEND_RET`, `RPT_F10_FH`, `RPT_FHPG_*`, etc.) return `{"success":false,"code":9501}`. This was extensively investigated and is a dead end.
