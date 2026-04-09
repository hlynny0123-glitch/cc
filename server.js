const express = require('express');
const https = require('https');
const iconv = require('iconv-lite');
const path = require('path');

const app = express();
const PORT = 3000;

// Basic auth middleware
app.use((req, res, next) => {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const [, password] = decoded.split(':');
    if (password === '241216') return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="A股追踪器"');
  res.status(401).send('请输入密码');
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Simple in-memory cache (10s TTL during market hours)
const cache = new Map();
const CACHE_TTL = 10000;

function isMarketOpen() {
  const now = new Date();
  // Convert to Beijing time (UTC+8)
  const beijing = new Date(now.getTime() + (8 * 60 * 60 * 1000));
  const day = beijing.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const h = beijing.getUTCHours();
  const m = beijing.getUTCMinutes();
  const minutes = h * 60 + m;
  // 9:25-11:30 and 13:00-15:00
  return (minutes >= 565 && minutes <= 690) || (minutes >= 780 && minutes <= 900);
}

function parseSinaResponse(raw) {
  const results = {};
  const lines = raw.split('\n');
  for (const line of lines) {
    const match = line.match(/hq_str_([a-z]{2}\d{6})="(.+)"/);
    if (!match) continue;
    const code = match[1];
    const fields = match[2].split(',');
    if (fields.length < 10 || !fields[0]) continue;

    const current = parseFloat(fields[3]);
    const prevClose = parseFloat(fields[2]);
    const open = parseFloat(fields[1]);
    const high = parseFloat(fields[4]);
    const low = parseFloat(fields[5]);
    const change = parseFloat((current - prevClose).toFixed(3));
    const changePct = prevClose > 0
      ? parseFloat(((change / prevClose) * 100).toFixed(2))
      : 0;

    results[code] = {
      name: fields[0],
      current,
      prevClose,
      open,
      high,
      low,
      change,
      changePct,
      volume: parseInt(fields[8]) || 0,
      amount: parseFloat(fields[9]) || 0,
      date: fields[31] || '',
      time: fields[32] || '',
    };
  }
  return results;
}

function fetchFromSina(codes) {
  return new Promise((resolve, reject) => {
    const key = codes.slice().sort().join(',');
    const cached = cache.get(key);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
      return resolve(cached.data);
    }

    const url = `https://hq.sinajs.cn/list=${codes.join(',')}`;
    const req = https.get(url, {
      headers: {
        Referer: 'https://finance.sina.com.cn',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          const text = iconv.decode(buf, 'gbk');
          const data = parseSinaResponse(text);
          cache.set(key, { data, ts: Date.now() });
          resolve(data);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Auto-detect exchange prefix (sh/sz) from 6-digit code
function normalizeCode(raw) {
  raw = raw.trim().toLowerCase();
  if (/^(sh|sz)\d{6}$/.test(raw)) return raw;
  if (/^\d{6}$/.test(raw)) {
    // 6x = Shanghai, 0x/3x = Shenzhen
    return raw.startsWith('6') ? `sh${raw}` : `sz${raw}`;
  }
  return null;
}

// GET /api/search?q=茅台 or q=600519
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const url = `https://suggest3.sinajs.cn/suggest/type=11,12&key=${encodeURIComponent(q)}&name=suggestdata`;
  const request = https.get(url, {
    headers: {
      Referer: 'https://finance.sina.com.cn',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
  }, (response) => {
    const chunks = [];
    response.on('data', c => chunks.push(c));
    response.on('end', () => {
      try {
        const text = iconv.decode(Buffer.concat(chunks), 'gbk');
        // API response: var suggestdata="name,type,code6,exchange_code,fullname,...;..."
        const match = text.match(/suggestdata="(.*)"/);
        if (!match || !match[1]) return res.json([]);

        const results = match[1].split(';').filter(Boolean).map(item => {
          const f = item.split(',');
          // f[0]=shortname f[1]=type f[2]=code6 f[3]=exchange_code(sh600519) f[4]=fullname
          const code = f[3] && /^(sh|sz)\d{6}$/.test(f[3]) ? f[3]
                     : f[1] === '11' ? `sh${f[2]}` : `sz${f[2]}`;
          const name = f[4] || f[0];
          return { name, code, type: f[1] };
        }).filter(r => /^(sh|sz)\d{6}$/.test(r.code));

        res.json(results.slice(0, 10));
      } catch (e) {
        res.json([]);
      }
    });
  });
  request.on('error', () => res.json([]));
  request.setTimeout(5000, () => { request.destroy(); res.json([]); });
});

// GET /api/dividend/600519  — scrape TongHuaShun F10 bonus page for per-share dividend
app.get('/api/dividend/:code', (req, res) => {
  const code6 = req.params.code.replace(/^(sh|sz)/i, '').slice(0, 6);
  if (!/^\d{6}$/.test(code6)) return res.status(400).json({ error: 'Invalid code' });

  const url = `https://basic.10jqka.com.cn/${code6}/bonus.html`;

  const request = https.get(url, {
    headers: {
      Referer:      'https://www.10jqka.com.cn',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  }, (response) => {
    const chunks = [];
    response.on('data', c => chunks.push(c));
    response.on('end', () => {
      try {
        const text = iconv.decode(Buffer.concat(chunks), 'gbk');

        // Each completed distribution row contains "实施方案" and "10派X元"
        const rowRe = /<tr[^>]*J_pageritem[^>]*>([\s\S]*?)<\/tr>/g;
        const cutoff = new Date();
        cutoff.setFullYear(cutoff.getFullYear() - 1);

        let totalPerShare = 0, latestDate = null, count = 0;
        const recentDists = [];
        const fallbacks = [];

        let rowMatch;
        while ((rowMatch = rowRe.exec(text)) !== null) {
          const row = rowMatch[1];
          if (!row.includes('实施方案')) continue;

          // Extract all cell texts
          const cells = [];
          const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
          let tdMatch;
          while ((tdMatch = tdRe.exec(row)) !== null) {
            cells.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
          }

          // Find "10派X元(含税)" cell
          const planCell = cells.find(c => /10派[\d.]+元/.test(c));
          if (!planCell) continue;
          const amtMatch = planCell.match(/10派([\d.]+)元/);
          if (!amtMatch) continue;
          const perShare = parseFloat((parseFloat(amtMatch[1]) / 10).toFixed(4));

          // Ex-dividend date: use the second-to-last valid date in the row
          const dates = cells.filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c));
          const exDate = dates.length >= 2 ? dates[dates.length - 2] : dates[dates.length - 1];

          if (exDate) {
            if (new Date(exDate) >= cutoff) {
              totalPerShare += perShare;
              if (!latestDate) latestDate = exDate;
              count++;
              recentDists.push({ perShare, date: exDate });
            } else {
              fallbacks.push({ perShare, exDate });
            }
          }
        }

        // Fallback: most recent single record if none within 12 months
        if (count === 0 && fallbacks.length) {
          totalPerShare = fallbacks[0].perShare;
          latestDate    = fallbacks[0].exDate;
          count         = 1;
          recentDists.push({ perShare: fallbacks[0].perShare, date: fallbacks[0].exDate });
        }

        res.json({
          perShare:      totalPerShare > 0 ? parseFloat(totalPerShare.toFixed(4)) : null,
          latestDate,
          count,
          distributions: recentDists,
        });
      } catch (e) {
        res.json({ perShare: null });
      }
    });
  });
  request.on('error', () => res.json({ perShare: null }));
  request.setTimeout(8000, () => { request.destroy(); res.json({ perShare: null }); });
});

// GET /api/stocks?codes=600519,sh000001
app.get('/api/stocks', async (req, res) => {
  const raw = (req.query.codes || '').split(',').map(c => c.trim()).filter(Boolean);
  const codes = raw.map(normalizeCode).filter(Boolean);
  if (!codes.length) return res.json({});

  try {
    const data = await fetchFromSina(codes);
    res.json(data);
  } catch (err) {
    console.error('Sina fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch stock data', detail: err.message });
  }
});

// GET /api/market-status
app.get('/api/market-status', (_req, res) => {
  res.json({ open: isMarketOpen() });
});

app.listen(PORT, () => {
  console.log(`\n✅  A股追踪器 running at http://localhost:${PORT}\n`);
});
