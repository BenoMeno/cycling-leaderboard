// ─────────────────────────────────────────────────────────────
//  Cycling Leaderboard – Backend Server
//  intervals.icu API (Basic Auth with personal API keys)
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { PORT = 3000 } = process.env;

// ── File-based database ───────────────────────────────────────
const DB_FILE      = path.join(__dirname, 'data', 'athletes.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'history.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return {}; }
}

function saveDB(data) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return []; }
}

function saveHistory(data) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

// ── Fetch athlete profile ─────────────────────────────────────
async function getAthleteProfile(athleteId, apiKey) {
  const { data } = await axios.get(
    `https://intervals.icu/api/v1/athlete/${athleteId}`,
    { auth: { username: 'API_KEY', password: apiKey } }
  );
  return data;
}

// ── Get cycling stats for a specific month ────────────────────
async function getMonthlyStats(athlete, year, month) {
  const pad     = n => String(n).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  const oldest  = `${year}-${pad(month)}-01`;
  const newest  = `${year}-${pad(month)}-${lastDay}`;
  console.log(`[${athlete.name}] Fetching activities ${oldest} → ${newest}`);

  const { data } = await axios.get(
    `https://intervals.icu/api/v1/athlete/${athlete.athleteId}/activities`,
    {
      auth: { username: 'API_KEY', password: athlete.apiKey },
      params: { oldest, newest, fields: 'name,type,distance,total_elevation_gain' },
    }
  );

  const typesFound = [...new Set(data.map(a => a.type))];
  console.log(`[${athlete.name}] ${data.length} activities. Types: ${typesFound.join(', ') || 'none'}`);

  const rideTypes = ['ride', 'virtual', 'ebike', 'gravel', 'mountain', 'cycling', 'bike', 'velomobile'];

  let totalKm = 0, totalElevation = 0, totalRides = 0;
  for (const act of data) {
    const type = (act.type || '').toLowerCase();
    if (rideTypes.some(t => type.includes(t))) {
      totalKm        += (act.distance || 0) / 1000;
      totalElevation += (act.total_elevation_gain || 0);
      totalRides++;
    }
  }

  console.log(`[${athlete.name}] → ${totalKm.toFixed(1)} km, ${totalElevation} m, ${totalRides} rides`);

  return {
    km:        Math.round(totalKm * 10) / 10,
    elevation: Math.round(totalElevation),
    rides:     totalRides,
  };
}

// ── Fetch leaderboard for a given month ───────────────────────
async function fetchLeaderboard(year, month) {
  const db       = loadDB();
  const athletes = Object.values(db);
  if (athletes.length === 0) return [];

  const results = await Promise.allSettled(
    athletes.map(async (a) => {
      try {
        const stats = await getMonthlyStats(a, year, month);
        return { name: a.name, ...stats };
      } catch (err) {
        console.error(`[${a.name}] Failed:`, err.response?.status, err.message);
        throw err;
      }
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
}

// ── Snapshot: save final standings for a completed month ──────
async function snapshotMonth(year, month) {
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const history = loadHistory();

  // Don't double-snapshot the same month
  if (history.find(h => h.month === key)) {
    console.log(`[snapshot] ${key} already exists, skipping.`);
    return;
  }

  console.log(`[snapshot] Saving final standings for ${key}…`);
  const riders = await fetchLeaderboard(year, month);

  if (riders.length === 0) {
    console.log(`[snapshot] No riders found for ${key}, skipping.`);
    return;
  }

  history.unshift({ month: key, savedAt: new Date().toISOString(), riders });
  saveHistory(history);
  console.log(`[snapshot] Saved ${riders.length} riders for ${key}.`);
}

// ── Check on startup if last month needs snapshotting ─────────
async function checkMissedSnapshot() {
  const now       = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth(), 0); // last day of prev month
  const year      = lastMonth.getFullYear();
  const month     = lastMonth.getMonth() + 1;
  const key       = `${year}-${String(month).padStart(2, '0')}`;
  const history   = loadHistory();

  if (!history.find(h => h.month === key)) {
    console.log(`[snapshot] Missing snapshot for ${key}, creating now…`);
    await snapshotMonth(year, month);
  }
}

// ── Schedule end-of-month snapshot ───────────────────────────
// Runs every hour; snapshots when we've just crossed into a new month
let lastCheckedMonth = new Date().getMonth();

setInterval(async () => {
  const now = new Date();
  if (now.getMonth() !== lastCheckedMonth) {
    lastCheckedMonth = now.getMonth();
    const prev      = new Date(now.getFullYear(), now.getMonth(), 0);
    await snapshotMonth(prev.getFullYear(), prev.getMonth() + 1);
  }
}, 60 * 60 * 1000); // every hour

// ── Routes ────────────────────────────────────────────────────

// Register a new athlete
app.post('/api/join', async (req, res) => {
  const { athleteId, apiKey } = req.body;
  if (!athleteId || !apiKey)
    return res.status(400).json({ error: 'athleteId and apiKey are required' });

  try {
    const profile     = await getAthleteProfile(athleteId, apiKey);
    const displayName = profile.name || `Athlete ${athleteId}`;
    const db          = loadDB();
    db[athleteId]     = { athleteId, apiKey, name: displayName };
    saveDB(db);
    res.json({ success: true, name: displayName });
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403)
      return res.status(401).json({ error: 'Invalid Athlete ID or API key — check your credentials.' });
    console.error('Join error:', err.message);
    res.status(500).json({ error: 'Could not connect to intervals.icu. Please try again.' });
  }
});

// Current month leaderboard
app.get('/api/leaderboard', async (req, res) => {
  const now    = new Date();
  const riders = await fetchLeaderboard(now.getFullYear(), now.getMonth() + 1);
  res.json({ riders });
});

// Full history
app.get('/api/history', (req, res) => {
  res.json(loadHistory());
});

// Manually trigger a snapshot for a specific month (admin use)
// e.g. POST /api/snapshot { "year": 2026, "month": 3 }
app.post('/api/snapshot', async (req, res) => {
  const { year, month } = req.body;
  if (!year || !month)
    return res.status(400).json({ error: 'year and month required' });
  try {
    await snapshotMonth(year, month);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove an athlete
app.delete('/api/athlete/:id', (req, res) => {
  const db = loadDB();
  if (db[req.params.id]) {
    delete db[req.params.id];
    saveDB(db);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚴  Cycling Leaderboard running on http://localhost:${PORT}\n`);
  await checkMissedSnapshot();
});
