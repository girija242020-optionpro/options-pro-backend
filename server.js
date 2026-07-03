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
