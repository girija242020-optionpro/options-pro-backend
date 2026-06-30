const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════
// SESSION STATE
// ═══════════════════════════════════════════
let session = { jwtToken: null, refreshToken: null, lastLogin: null };
let nseCookie = '';
let cookieTime = 0;

// In-memory candle history store: { "NIFTY_24100_CE": [{time, ltp, oi, volume}, ...] }
let candleHistory = {};
const MAX_CANDLES = 60; // keep last 60 minutes

// ═══════════════════════════════════════════
// TOTP GENERATOR
// ═══════════════════════════════════════════
function generateTOTP(secret) {
  try {
    const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    secret = secret.toUpperCase().replace(/\s+/g, '').replace(/=/g, '');
    let bits = '';
    for (let i = 0; i < secret.length; i++) {
      const v = base32.indexOf(secret[i]);
      if (v === -1) continue;
      bits += v.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    const key = Buffer.from(bytes);
    const counter = Math.floor(Date.now() / 1000 / 30);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
    return String(code % 1000000).padStart(6, '0');
  } catch (e) {
    console.log('TOTP generation error:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════
// ANGEL ONE LOGIN
// ═══════════════════════════════════════════
async function loginAngelOne() {
  try {
    const { CLIENT_CODE, PIN, API_KEY, TOTP_SECRET } = process.env;
    if (!CLIENT_CODE || !PIN || !API_KEY || !TOTP_SECRET) {
      console.log('❌ Missing environment variables. Need: CLIENT_CODE, PIN, API_KEY, TOTP_SECRET');
      return false;
    }
    const totp = generateTOTP(TOTP_SECRET);
    if (!totp) { console.log('❌ TOTP generation failed — check TOTP_SECRET format'); return false; }

    console.log('🔐 Attempting Angel One login, generated TOTP:', totp);

    const resp = await axios.post(
      'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
      { clientcode: CLIENT_CODE.trim(), password: PIN.trim(), totp: totp },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': API_KEY.trim()
        },
        timeout: 15000
      }
    );

    if (resp.data.status && resp.data.data) {
      session.jwtToken = resp.data.data.jwtToken;
      session.refreshToken = resp.data.data.refreshToken;
      session.lastLogin = Date.now();
      console.log('✅ Angel One LOGIN SUCCESS');
      return true;
    } else {
      console.log('❌ Login failed:', resp.data.message, '| Error code:', resp.data.errorcode);
      return false;
    }
  } catch (e) {
    console.log('❌ Login exception:', e.message);
    if (e.response) console.log('Response data:', JSON.stringify(e.response.data));
    return false;
  }
}

// ═══════════════════════════════════════════
// NSE FALLBACK (Option Chain Source)
// ═══════════════════════════════════════════
async function getNSECookie() {
  if (Date.now() - cookieTime < 240000 && nseCookie) return;
  try {
    const r = await axios.get('https://www.nseindia.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html' },
      timeout: 12000
    });
    const c = r.headers['set-cookie'];
    if (c) { nseCookie = c.map(x => x.split(';')[0]).join('; '); cookieTime = Date.now(); }
    await axios.get('https://www.nseindia.com/option-chain', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Referer': 'https://www.nseindia.com/', 'Cookie': nseCookie },
      timeout: 12000
    });
  } catch (e) { console.log('NSE cookie error:', e.message); }
}

async function nseGet(endpoint) {
  await getNSECookie();
  const r = await axios.get('https://www.nseindia.com/api/' + endpoint, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.nseindia.com/option-chain',
      'Cookie': nseCookie,
      'X-Requested-With': 'XMLHttpRequest'
    },
    timeout: 15000
  });
  return r.data;
}

// ═══════════════════════════════════════════
// ANGEL ONE QUOTE
// ═══════════════════════════════════════════
async function getAOQuote(tokens) {
  if (!session.jwtToken) return null;
  if (Date.now() - session.lastLogin > 7 * 60 * 60 * 1000) await loginAngelOne();
  try {
    const resp = await axios.post(
      'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/',
      { mode: 'FULL', exchangeTokens: { NSE: tokens } },
      {
        headers: {
          'Content-Type': 'application/json', 'Accept': 'application/json',
          'X-UserType': 'USER', 'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1', 'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': process.env.API_KEY, 'Authorization': 'Bearer ' + session.jwtToken
        },
        timeout: 12000
      }
    );
    if (resp.data.status && resp.data.data) return resp.data.data.fetched;
    return null;
  } catch (e) { console.log('AO Quote error:', e.message); return null; }
}

// ═══════════════════════════════════════════
// CANDLE HISTORY COLLECTOR (for RSI/breakout detection)
// ═══════════════════════════════════════════
function recordCandle(key, ltp, oi, volume) {
  if (!candleHistory[key]) candleHistory[key] = [];
  const arr = candleHistory[key];
  const now = Date.now();
  const lastCandle = arr[arr.length - 1];

  // New candle every 60 seconds
  if (!lastCandle || now - lastCandle.time >= 60000) {
    arr.push({ time: now, open: ltp, high: ltp, low: ltp, close: ltp, oi, volume });
  } else {
    lastCandle.high = Math.max(lastCandle.high, ltp);
    lastCandle.low = Math.min(lastCandle.low, ltp);
    lastCandle.close = ltp;
    lastCandle.oi = oi;
    lastCandle.volume = volume;
  }
  if (arr.length > MAX_CANDLES) arr.shift();
}

// RSI calculator
function calcRSI(candles, period) {
  if (candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Breakout detection — RSI compression + crossover + volume spike
function detectBreakout(key) {
  const arr = candleHistory[key];
  if (!arr || arr.length < 10) return { status: 'insufficient_data', candles: arr ? arr.length : 0 };

  const rsi9 = calcRSI(arr, 9);
  const rsi5 = calcRSI(arr, 5);
  if (rsi9 === null || rsi5 === null) return { status: 'insufficient_data' };

  // Check last 5 candles for compression (RSI was flat/low)
  const recentCloses = arr.slice(-8).map(c => c.close);
  const avgPrice = recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length;
  const priceRange = Math.max(...recentCloses) - Math.min(...recentCloses);
  const compressionRatio = avgPrice > 0 ? priceRange / avgPrice : 1;
  const isCompressed = compressionRatio < 0.15; // tight range = compression

  // Volume spike check
  const currentVol = arr[arr.length - 1].volume;
  const avgVol = arr.slice(-6, -1).reduce((s, c) => s + (c.volume || 0), 0) / 5;
  const volumeSpike = avgVol > 0 ? currentVol / avgVol : 1;

  // RSI crossover (both RSI crossing above 50 together = bullish trigger)
  const rsiCrossUp = rsi5 > 50 && rsi9 > 45 && rsi5 > rsi9;
  const rsiCrossDown = rsi5 < 50 && rsi9 < 55 && rsi5 < rsi9;

  let breakoutScore = 0;
  if (isCompressed) breakoutScore += 25;
  if (volumeSpike > 1.5) breakoutScore += 25;
  if (volumeSpike > 2.5) breakoutScore += 15;
  if (rsiCrossUp || rsiCrossDown) breakoutScore += 35;

  return {
    status: 'ok',
    rsi9: Number(rsi9.toFixed(2)),
    rsi5: Number(rsi5.toFixed(2)),
    isCompressed,
    compressionRatio: Number(compressionRatio.toFixed(3)),
    volumeSpike: Number(volumeSpike.toFixed(2)),
    direction: rsiCrossUp ? 'bullish' : rsiCrossDown ? 'bearish' : 'neutral',
    breakoutScore,
    candleCount: arr.length
  };
}

// ═══════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    status: 'Options Pro Backend v2 — Running ✅',
    angelConnected: !!session.jwtToken,
    lastLogin: session.lastLogin ? new Date(session.lastLogin).toISOString() : null,
    sessionAgeMin: session.lastLogin ? Math.floor((Date.now() - session.lastLogin) / 60000) : null,
    candleKeysTracked: Object.keys(candleHistory).length
  });
});

// Nifty Spot
app.get('/nifty-spot', async (req, res) => {
  try {
    const quotes = await getAOQuote(['26000', '26009']);
    if (quotes && quotes.length > 0) {
      const nifty = quotes.find(q => q.symbolToken === '26000');
      const bank = quotes.find(q => q.symbolToken === '26009');
      if (nifty) {
        return res.json({ success: true, spot: nifty.ltp, bankNifty: bank?.ltp, vix: null, change: nifty.percentChange, source: 'angelone' });
      }
    }
    const d = await nseGet('allIndices');
    const n = d.data?.find(i => i.index === 'NIFTY 50');
    const b = d.data?.find(i => i.index === 'NIFTY BANK');
    const v = d.data?.find(i => i.index === 'INDIA VIX');
    res.json({ success: true, spot: n?.last, bankNifty: b?.last, vix: v?.last, change: n?.percentChange, source: 'nse' });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// Full Option Chain — also records candle history for breakout detection
app.get('/nifty-option-chain', async (req, res) => {
  try {
    const sym = (req.query.symbol || 'NIFTY').toUpperCase();
    const data = await nseGet('option-chain-indices?symbol=' + sym);
    if (!data || !data.records) return res.json({ success: false, message: 'No data available' });

    const spot = data.records.underlyingValue;
    const expiries = data.records.expiryDates || [];
    const exp = expiries[0];
    const all = data.filtered?.data || data.records?.data || [];
    const chain = exp ? all.filter(i => i.expiryDate === exp) : all;

    const strikes = chain.map(item => {
      const ce = item.CE || {};
      const pe = item.PE || {};

      // Record candle history for breakout detection
      if (ce.lastPrice) recordCandle(`${sym}_${item.strikePrice}_CE`, ce.lastPrice, ce.openInterest, ce.totalTradedVolume);
      if (pe.lastPrice) recordCandle(`${sym}_${item.strikePrice}_PE`, pe.lastPrice, pe.openInterest, pe.totalTradedVolume);

      return {
        strike: item.strikePrice,
        ce: {
          oi: ce.openInterest || 0, oiChange: ce.changeinOpenInterest || 0,
          volume: ce.totalTradedVolume || 0, iv: ce.impliedVolatility || 0,
          ltp: ce.lastPrice || 0, bid: ce.bidprice || 0, ask: ce.askPrice || 0
        },
        pe: {
          oi: pe.openInterest || 0, oiChange: pe.changeinOpenInterest || 0,
          volume: pe.totalTradedVolume || 0, iv: pe.impliedVolatility || 0,
          ltp: pe.lastPrice || 0, bid: pe.bidprice || 0, ask: pe.askPrice || 0
        }
      };
    });

    const tce = strikes.reduce((s, i) => s + i.ce.oi, 0);
    const tpe = strikes.reduce((s, i) => s + i.pe.oi, 0);
    const pcr = tce > 0 ? (tpe / tce).toFixed(2) : '1.0';

    let mp = Math.round(spot / 50) * 50, minP = Infinity;
    strikes.forEach(s => {
      let l = 0;
      strikes.forEach(t => { l += Math.max(0, t.strike - s.strike) * t.ce.oi; l += Math.max(0, s.strike - t.strike) * t.pe.oi; });
      if (l < minP) { minP = l; mp = s.strike; }
    });

    res.json({
      success: true, spot, expiry: exp, expiries: expiries.slice(0, 5),
      pcr, maxPain: mp, totalCeOI: tce, totalPeOI: tpe, strikes,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    if (e.response?.status === 401 || e.response?.status === 403) { nseCookie = ''; cookieTime = 0; }
    res.json({ success: false, message: e.message, code: e.response?.status });
  }
});

// VIX
app.get('/vix', async (req, res) => {
  try {
    const d = await nseGet('allIndices');
    const v = d.data?.find(i => i.index === 'INDIA VIX');
    res.json({ success: true, vix: v?.last, change: v?.percentChange });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// Breakout Scanner — checks all tracked strikes for compression + RSI crossover + volume spike
app.get('/breakout-scan', (req, res) => {
  const results = [];
  Object.keys(candleHistory).forEach(key => {
    const result = detectBreakout(key);
    if (result.status === 'ok' && result.breakoutScore >= 40) {
      const [symbol, strike, type] = key.split('_');
      results.push({ symbol, strike: Number(strike), type, ...result });
    }
  });
  results.sort((a, b) => b.breakoutScore - a.breakoutScore);
  res.json({ success: true, count: results.length, results: results.slice(0, 10), totalTracked: Object.keys(candleHistory).length });
});

// Get candle history for a specific strike (for charting)
app.get('/candles', (req, res) => {
  const { symbol, strike, type } = req.query;
  const key = `${symbol}_${strike}_${type}`;
  const arr = candleHistory[key] || [];
  res.json({ success: true, key, candles: arr });
});

app.get('/status', (req, res) => res.json({
  angelConnected: !!session.jwtToken,
  sessionAgeMin: session.lastLogin ? Math.floor((Date.now() - session.lastLogin) / 60000) : null,
  candlesTracked: Object.keys(candleHistory).length
}));

app.post('/login', async (req, res) => {
  const ok = await loginAngelOne();
  res.json({ success: ok });
});

// ═══════════════════════════════════════════
// BACKGROUND JOBS
// ═══════════════════════════════════════════

// Auto re-login every 7 hours
setInterval(async () => { if (session.jwtToken) await loginAngelOne(); }, 7 * 60 * 60 * 1000);

// NSE cookie refresh every 3 min
setInterval(getNSECookie, 3 * 60 * 1000);

// Auto-poll option chain every 60 seconds during market hours to build candle history
setInterval(async () => {
  const now = new Date();
  const hour = now.getUTCHours() + 5.5; // IST
  if (hour >= 9.25 && hour <= 15.5) {
    try {
      await nseGet('option-chain-indices?symbol=NIFTY');
    } catch (e) { /* silent */ }
  }
}, 60000);

// Startup
loginAngelOne().then(ok => {
  console.log(ok ? '✅ Startup: Angel One connected' : '⚠️ Startup: Angel One login failed — will use NSE fallback');
  getNSECookie();
});

app.listen(PORT, () => console.log(`🚀 Options Pro Backend v2 running on port ${PORT}`));
