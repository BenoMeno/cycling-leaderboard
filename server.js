// ─────────────────────────────────────────────────────────────
//  Cycling Leaderboard – Backend Server
//  Node.js + Express
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ───────────────────────────────────────────────────
const {
  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  BASE_URL,          // e.g. https://yourdomain.com or http://localhost:3000
  PORT = 3000,
} = process.env;

// ── Simple file-based "database" ─────────────────────────────
// Stores: { userId: { name, accessToken, refreshToken, expiresAt, stravaId } }
const DB_FILE = path.join(__dirname, 'data', 'athletes.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return {}; }
}

function saveDB(data) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── Token refresh ─────────────────────────────────────────────
async function getValidToken(athlete) {
  if (Date.now() / 1000 < athlete.expiresAt - 300) {
    return athlete.accessToken;
  }
  // Refresh the token
  const res = await axios.post('https://www.strava.com/oauth/token', {
    client_id:     STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: athlete.refreshToken,
  });
  athlete.accessToken  = res.data.access_token;
  athlete.refreshToken = res.data.refresh_token;
  athlete.expiresAt    = res.data.expires_at;
  const db = loadDB();
  db[athlete.stravaId] = athlete;
  saveDB(db);
  return athlete.accessToken;
}

// ── Get this month's cycling km for one athlete ───────────────
async function getMonthlyKm(athlete) {
  const now   = new Date();
  const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  const token = await getValidToken(athlete);

  let page = 1, totalKm = 0, totalRides = 0;

  while (true) {
    const { data } = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
      headers: { Authorization: `Bearer ${token}` },
      params: { after: start, per_page: 100, page },
    });

    if (!data.length) break;

    for (const act of data) {
      if (['Ride', 'VirtualRide', 'EBikeRide', 'GravelRide', 'MountainBikeRide'].includes(act.type)) {
        totalKm += act.distance / 1000;
        totalRides++;
      }
    }

    if (data.length < 100) break;
    page++;
  }

  return { km: Math.round(totalKm * 10) / 10, rides: totalRides };
}

// ── Routes ────────────────────────────────────────────────────

// Step 1: Start Strava OAuth
app.get('/auth/strava', (req, res) => {
  if (!STRAVA_CLIENT_ID) {
    return res.send('⚠️  STRAVA_CLIENT_ID not set in .env — check SETUP.md');
  }
  const scope    = 'read,activity:read';
  const redirect = `${BASE_URL}/auth/strava/callback`;
  const url = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${scope}`;
  res.redirect(url);
});

// Step 2: Strava redirects back here with a code
app.get('/auth/strava/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect('/?error=' + encodeURIComponent(error || 'access_denied'));
  }

  try {
    const { data } = await axios.post('https://www.strava.com/oauth/token', {
      client_id:     STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
    });

    const db = loadDB();
    db[data.athlete.id] = {
      stravaId:     data.athlete.id,
      name:         `${data.athlete.firstname} ${data.athlete.lastname}`,
      accessToken:  data.access_token,
      refreshToken: data.refresh_token,
      expiresAt:    data.expires_at,
    };
    saveDB(db);

    res.redirect('/?connected=1');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// Step 3: Leaderboard API — called by the frontend
app.get('/api/leaderboard', async (req, res) => {
  const db = loadDB();
  const athletes = Object.values(db);

  if (athletes.length === 0) {
    return res.json({ riders: [] });
  }

  const results = await Promise.allSettled(
    athletes.map(async (a) => {
      const { km, rides } = await getMonthlyKm(a);
      return { name: a.name, km, rides };
    })
  );

  const riders = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
    .sort((a, b) => b.km - a.km);

  res.json({ riders });
});

// ── Strava Webhook ────────────────────────────────────────────
// (Optional: Strava pings this when a new activity is created)
// You can verify this endpoint in Strava's webhook settings.
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'cycling-challenge';
  if (req.query['hub.challenge'] && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.json({ 'hub.challenge': req.query['hub.challenge'] });
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
  // Strava sends activity events here — we just acknowledge.
  // In production you could trigger a cache refresh here.
  res.sendStatus(200);
  console.log('Webhook event:', req.body);
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚴  Cycling Leaderboard running on http://localhost:${PORT}\n`);
  if (!STRAVA_CLIENT_ID) {
    console.warn('⚠️  STRAVA_CLIENT_ID not set — check SETUP.md before going further!\n');
  }
});
