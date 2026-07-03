// ============================================================
// GAMMA X BACKEND — Nifty + Sensex Fair Value & Gamma Blast Engine
// Angel One SmartAPI (auto-TOTP) + optionGreek auto-IV
// Env vars needed on Render: CLIENT_CODE, PIN, API_KEY, TOTP_SECRET
// ============================================================
const express = require('express');
const cors = require('cors');
const { authenticator } = require('otplib');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CLIENT_CODE = process.env.CLIENT_CODE || '';
const PIN = process.env.PIN || '';
const API_KEY = process.env.API_KEY || '';
const TOTP_SECRET = process.env.TOTP_SECRET || '';
const RISK_FREE = parseFloat(process.env.RISK_FREE || '6.5');
const DIV_YIELD = parseFloat(process.env.DIV_YIELD || '1.1');

const BASE = 'https://apiconnect.angelone.in';

// Index config: Angel One spot tokens + lot sizes + weekly expiry weekday
// NIFTY weekly expiry = Tuesday (2), SENSEX weekly = Thursday (4)  [override via ?expiry=DDMMMYYYY]
const INDEXES = {
  NIFTY:  { exch: 'NSE', token: '99926000', symbol: 'Nifty 50', lot: 75, step: 50,  expiryDow: 2, greekName: 'NIFTY' },
  SENSEX: { exch: 'BSE', token: '99919000', symbol: 'SENSEX',   lot: 20, step: 100, expiryDow: 4, greekName: 'SENSEX' }
};

// ---------------- Session ----------------
let session = { jwt: null, feed: null, at: 0 };

function headers() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '106.193.147.98',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': API_KEY,
    ...(session.jwt ? { 'Authorization': 'Bearer ' + session.jwt } : {})
  };
}

async function login() {
  const totp = authenticator.generate(TOTP_SECRET);
  const r = await fetch(BASE + '/rest/auth/angelbroking/user/v1/loginByPassword', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ clientcode: CLIENT_CODE, password: PIN, totp })
  });
  const d = await r.json();
  if (!d.status || !d.data) throw new Error('Login failed: ' + (d.message || 'unknown'));
  session = { jwt: d.data.jwtToken, feed: d.data.feedToken, at: Date.now() };
  console.log('✅ Angel One login OK');
  return session;
}

async function ensureSession() {
  // Re-login every 6 hours or if never logged in
  if (!session.jwt || Date.now() - session.at > 6 * 3600 * 1000) {
    await login();
  }
  return session;
}

async function apiPost(path, body, retry = true) {
  await ensureSession();
  const r = await fetch(BASE + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if ((d.errorcode === 'AG8001' || d.errorcode === 'AG8002' || d.message === 'Invalid Token') && retry) {
    session.jwt = null;
    return apiPost(path, body, false);
  }
  return d;
}

// ---------------- Market data ----------------
async function getSpot(idx) {
  const cfg = INDEXES[idx];
  const d = await apiPost('/rest/secure/angelbroking/order/v1/getLtpData', {
    exchange: cfg.exch, tradingsymbol: cfg.symbol, symboltoken: cfg.token
  });
  if (d.status && d.data && d.data.ltp) return parseFloat(d.data.ltp);
  throw new Error(idx + ' spot fetch failed: ' + (d.message || 'no data'));
}

// Angel One optionGreek API → per strike: IV, delta, gamma, theta, vega, volume
async function getOptionGreeks(idx, expiry) {
  const cfg = INDEXES[idx];
  const d = await apiPost('/rest/secure/angelbroking/marketData/v1/optionGreek', {
    name: cfg.greekName, expirydate: expiry
  });
  if (d.status && Array.isArray(d.data)) return d.data;
  throw new Error('optionGreek failed for ' + idx + ' ' + expiry + ': ' + (d.message || JSON.stringify(d.errorcode || '')));
}

// ---------------- Expiry helpers ----------------
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function nextExpiry(dow) {
  // IST now
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  const d = new Date(now);
  let add = (dow - d.getUTCDay() + 7) % 7;
  // If today is expiry day but past 15:30 IST, jump to next week
  if (add === 0) {
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (mins > 15 * 60 + 30) add = 7;
  }
  d.setUTCDate(d.getUTCDate() + add);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return dd + MONTHS[d.getUTCMonth()] + d.getUTCFullYear(); // e.g. 07JUL2026
}

function dteFromExpiry(expiry) {
  const m = expiry.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!m) return null;
  const exp = Date.UTC(parseInt(m[3]), MONTHS.indexOf(m[2]), parseInt(m[1]), 10, 0, 0); // 15:30 IST = 10:00 UTC
  const days = (exp - Date.now()) / 86400000;
  return Math.max(days, 0.0005); // minutes-level precision near expiry
}

// ---------------- Math: BS + 2nd order Greeks ----------------
function ncdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  return 0.5 * (1 + s * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)));
}
function npdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

// S spot, K strike, T years, sig vol (decimal), r, q — returns full greek set
function bsFull(S, K, T, sig, r, q, type) {
  T = Math.max(T, 1e-6); sig = Math.max(sig, 1e-4);
  const sqT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sig * sig) * T) / (sig * sqT);
  const d2 = d1 - sig * sqT;
  const eq = Math.exp(-q * T), er = Math.exp(-r * T);
  const pd1 = npdf(d1);
  const Nd1 = ncdf(d1), Nd2 = ncdf(d2);
  let price, delta, rho, probITM, charm;
  if (type === 'CE') {
    price = S * eq * Nd1 - K * er * Nd2;
    delta = eq * Nd1;
    rho = K * T * er * Nd2 / 100;
    probITM = Nd2;
    charm = q * eq * Nd1 - eq * pd1 * (2 * (r - q) * T - d2 * sig * sqT) / (2 * T * sig * sqT);
  } else {
    price = K * er * ncdf(-d2) - S * eq * ncdf(-d1);
    delta = -eq * ncdf(-d1);
    rho = -K * T * er * ncdf(-d2) / 100;
    probITM = ncdf(-d2);
    charm = -q * eq * ncdf(-d1) - eq * pd1 * (2 * (r - q) * T - d2 * sig * sqT) / (2 * T * sig * sqT);
  }
  const gamma = eq * pd1 / (S * sig * sqT);
  const vega = S * eq * pd1 * sqT / 100;
  const thetaCE = (-(S * eq * pd1 * sig) / (2 * sqT) - r * K * er * Nd2 + q * S * eq * Nd1) / 365;
  const thetaPE = (-(S * eq * pd1 * sig) / (2 * sqT) + r * K * er * ncdf(-d2) - q * S * eq * ncdf(-d1)) / 365;
  const vanna = -eq * pd1 * d2 / sig;                                   // dDelta/dVol
  const vomma = (S * eq * pd1 * sqT) * d1 * d2 / sig / 100;             // dVega/dVol (per 1% vol)
  const speed = -(gamma / S) * (d1 / (sig * sqT) + 1);                  // dGamma/dSpot
  const zomma = gamma * (d1 * d2 - 1) / sig;                            // dGamma/dVol
  const color = -eq * pd1 / (2 * S * T * sig * sqT) *
    (2 * q * T + 1 + d1 * (2 * (r - q) * T - d2 * sig * sqT) / (sig * sqT)) / 365; // dGamma/dTime per day
  return {
    price, delta, gamma, vega,
    theta: type === 'CE' ? thetaCE : thetaPE,
    rho, probITM,
    charm: charm / 365,  // per day
    vanna, vomma, speed, color, zomma,
    d1, d2
  };
}

// ---------------- IV history (for "IV rising" detection) ----------------
// key: idx|expiry|strike|type → [{t, iv}]
const ivHist = new Map();
function trackIV(key, iv) {
  const arr = ivHist.get(key) || [];
  arr.push({ t: Date.now(), iv });
  while (arr.length > 40) arr.shift();
  ivHist.set(key, arr);
  if (arr.length < 3) return 0;
  const old = arr[0].iv, cur = arr[arr.length - 1].iv;
  return old > 0 ? (cur - old) / old : 0; // fractional change over window
}

// ---------------- Analyze engine ----------------
async function analyze(idx, expiryParam) {
  const cfg = INDEXES[idx];
  const expiry = expiryParam || nextExpiry(cfg.expiryDow);
  const dte = dteFromExpiry(expiry);
  const T = dte / 365;

  const [spot, greeksRaw] = await Promise.all([getSpot(idx), getOptionGreeks(idx, expiry)]);

  const atm = Math.round(spot / cfg.step) * cfg.step;
  const range = cfg.step * 12; // ATM ± 12 strikes

  // Normalize broker rows
  const rows = [];
  for (const g of greeksRaw) {
    const K = parseFloat(g.strikePrice);
    if (!K || Math.abs(K - atm) > range) continue;
    const type = (g.optionType || '').toUpperCase(); // CE / PE
    if (type !== 'CE' && type !== 'PE') continue;
    const iv = parseFloat(g.impliedVolatility) || 0;
    if (iv <= 0) continue;
    const vol = parseFloat(g.tradeVolume) || 0;
    const own = bsFull(spot, K, T, iv / 100, RISK_FREE / 100, DIV_YIELD / 100, type);
    const ivChg = trackIV(idx + '|' + expiry + '|' + K + '|' + type, iv);
    rows.push({
      strike: K, type, iv: +iv.toFixed(2), volume: vol,
      brokerDelta: parseFloat(g.delta) || own.delta,
      brokerGamma: parseFloat(g.gamma) || own.gamma,
      fairValue: +own.price.toFixed(2),
      delta: +own.delta.toFixed(4),
      gamma: +own.gamma.toFixed(6),
      theta: +own.theta.toFixed(2),
      vega: +own.vega.toFixed(2),
      charm: +own.charm.toFixed(5),
      vanna: +own.vanna.toFixed(2),
      vomma: +own.vomma.toFixed(2),
      speed: +(own.speed * 1e6).toFixed(3),  // scaled ×1e6 for readability
      color: +(own.color * 1e6).toFixed(3),  // scaled ×1e6 per day
      zomma: +own.zomma.toFixed(4),
      probITM: +(own.probITM * 100).toFixed(1),
      ivChange: +(ivChg * 100).toFixed(2)    // % change over tracked window
    });
  }

  if (!rows.length) throw new Error('No greek rows for ' + idx + ' ' + expiry);

  // IV smile / ATM IV
  const atmRows = rows.filter(r => r.strike === atm);
  const atmIV = atmRows.length ? atmRows.reduce((s, r) => s + r.iv, 0) / atmRows.length : rows[0].iv;
  const ceIVs = rows.filter(r => r.type === 'CE').sort((a, b) => a.strike - b.strike);
  const peIVs = rows.filter(r => r.type === 'PE').sort((a, b) => a.strike - b.strike);
  const skew = (peIVs.length && ceIVs.length)
    ? +(peIVs[0].iv - ceIVs[ceIVs.length - 1].iv).toFixed(2) : 0; // OTM PE IV − OTM CE IV

  // Expected move (1 SD) till expiry
  const expMove = +(spot * (atmIV / 100) * Math.sqrt(T)).toFixed(1);

  // GEX proxy per strike (no OI from this endpoint → use gamma × volume × lot × spot; sign: CE +, PE −)
  const gexByStrike = {};
  let totalGex = 0;
  for (const r of rows) {
    const g = r.gamma * Math.max(r.volume, 1) * cfg.lot * spot * (r.type === 'CE' ? 1 : -1);
    gexByStrike[r.strike] = (gexByStrike[r.strike] || 0) + g;
    totalGex += g;
  }
  const gexRegime = totalGex >= 0 ? 'POSITIVE' : 'NEGATIVE';

  // Volume PCR
  const ceVol = rows.filter(r => r.type === 'CE').reduce((s, r) => s + r.volume, 0);
  const peVol = rows.filter(r => r.type === 'PE').reduce((s, r) => s + r.volume, 0);
  const pcr = ceVol > 0 ? +(peVol / ceVol).toFixed(2) : 0;

  // ---- Gamma Blast Score (0–100) per strike ----
  const maxGamma = Math.max(...rows.map(r => r.gamma));
  for (const r of rows) {
    let s = 0;
    s += 30 * (r.gamma / maxGamma);                                   // gamma peak
    const distATM = Math.abs(r.strike - spot) / (cfg.step * 4);
    s += 20 * Math.max(0, 1 - distATM);                               // near ATM
    if (dte <= 1) s += 20; else if (dte <= 2) s += 14; else if (dte <= 3) s += 7; // DTE
    if (r.ivChange > 0.5) s += 10; else if (r.ivChange > 0) s += 5;   // IV rising
    if (gexRegime === 'NEGATIVE') s += 10;                            // dealer short gamma
    const volRank = r.volume / Math.max(...rows.map(x => x.volume), 1);
    s += 10 * volRank;                                                // activity
    r.blastScore = Math.round(Math.min(s, 100));
    r.blastZone = r.blastScore >= 70 ? 'HIGH' : r.blastScore >= 50 ? 'ELEVATED' : 'LOW';
  }

  rows.sort((a, b) => a.strike - b.strike || (a.type < b.type ? -1 : 1));
  const ranked = [...rows].sort((a, b) => b.blastScore - a.blastScore);
  const bestCE = ranked.find(r => r.type === 'CE');
  const bestPE = ranked.find(r => r.type === 'PE');

  return {
    success: true,
    index: idx, spot: +spot.toFixed(2), atm, expiry,
    dte: +dte.toFixed(3),
    minutesToExpiry: Math.round(dte * 24 * 60),
    atmIV: +atmIV.toFixed(2), skew, expectedMove: expMove,
    rangeLow: +(spot - expMove).toFixed(0), rangeHigh: +(spot + expMove).toFixed(0),
    gexRegime, totalGex: Math.round(totalGex), pcr,
    lot: cfg.lot,
    bestCE, bestPE,
    topBlast: ranked.slice(0, 6),
    chain: rows,
    riskFree: RISK_FREE, divYield: DIV_YIELD,
    generatedAt: new Date().toISOString(),
    note: 'GEX is a volume-based proxy (optionGreek API OI nahi deta). Paper trading / analysis only.'
  };
}

// ---------------- Routes ----------------
app.get('/', (req, res) => res.json({
  app: 'Gamma X Backend', ok: true,
  endpoints: ['/health', '/spot', '/analyze?index=NIFTY|SENSEX[&expiry=07JUL2026]', '/nifty-spot (legacy)']
}));

app.get('/health', async (req, res) => {
  try { await ensureSession(); res.json({ success: true, loggedIn: !!session.jwt, time: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/spot', async (req, res) => {
  try {
    const [nifty, sensex] = await Promise.allSettled([getSpot('NIFTY'), getSpot('SENSEX')]);
    res.json({
      success: true,
      nifty: nifty.status === 'fulfilled' ? nifty.value : null,
      sensex: sensex.status === 'fulfilled' ? sensex.value : null
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Legacy route (old PWAs use this)
app.get('/nifty-spot', async (req, res) => {
  try {
    const [nifty, sensex] = await Promise.allSettled([getSpot('NIFTY'), getSpot('SENSEX')]);
    res.json({
      success: true,
      spot: nifty.status === 'fulfilled' ? nifty.value : null,
      nifty: nifty.status === 'fulfilled' ? nifty.value : null,
      sensex: sensex.status === 'fulfilled' ? sensex.value : null
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/analyze', async (req, res) => {
  try {
    const idx = (req.query.index || 'NIFTY').toUpperCase();
    if (!INDEXES[idx]) return res.status(400).json({ success: false, error: 'index must be NIFTY or SENSEX' });
    const data = await analyze(idx, req.query.expiry ? req.query.expiry.toUpperCase() : null);
    res.json(data);
  } catch (e) {
    console.error('analyze error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, () => console.log('🚀 Gamma X backend on :' + PORT));
