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
// Stores: { athleteId: { name, athleteId, apiKey } }
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

// ── Fetch athlete profile from intervals.icu ──────────────────
async function getAthleteProfile(athleteId, apiKey) {
  const { data } = await axios.get(
    `https://intervals.icu/api/v1/athlete/${athleteId}`,
    { auth: { username: 'API_KEY', password: apiKey } }
  );
  return data;
}

// ── Get this month's cycling stats for one athlete ────────────
async function getMonthlyStats(athlete) {
  const now    = new Date();
  const oldest = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const newest = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-31`;

  const { data } = await axios.get(
    `https://intervals.icu/api/v1/athlete/${athlete.athleteId}/activities`,
    {
      auth: { username: 'API_KEY', password: athlete.apiKey },
      params: { oldest, newest, fields: 'name,type,distance,total_elevation_gain' },
    }
  );

  const rideTypes = ['ride', 'virtualride', 'ebike', 'gravel', 'mountainbike', 'cycling'];

  let totalKm = 0, totalElevation = 0, totalRides = 0;

  for (const act of data) {
    const type = (act.type || '').toLowerCase();
    if (rideTypes.some(t => type.includes(t))) {
      totalKm        += (act.distance || 0) / 1000;
      totalElevation += (act.total_elevation_gain || 0);
      totalRides++;
    }
  }

  return {
    km:        Math.round(totalKm * 10) / 10,
    elevation: Math.round(totalElevation),
    rides:     totalRides,
  };
}

// ── Routes ────────────────────────────────────────────────────

// Register a new athlete
app.post('/api/join', async (req, res) => {
  const { athleteId, apiKey } = req.body;

  if (!athleteId || !apiKey) {
    return res.status(400).json({ error: 'athleteId and apiKey are required' });
  }

  try {
    const profile     = await getAthleteProfile(athleteId, apiKey);
    const displayName = profile.name || `Athlete ${athleteId}`;

    const db = loadDB();
    db[athleteId] = { athleteId, apiKey, name: displayName };
    saveDB(db);

    res.json({ success: true, name: displayName });
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      return res.status(401).json({ error: 'Invalid Athlete ID or API key — check your credentials.' });
    }
    console.error('Join error:', err.message);
    res.status(500).json({ error: 'Could not connect to intervals.icu. Please try again.' });
  }
});

// Leaderboard — returns all riders with km, elevation, rides
app.get('/api/leaderboard', async (req, res) => {
  const db       = loadDB();
  const athletes = Object.values(db);

  if (athletes.length === 0) return res.json({ riders: [] });

  const results = await Promise.allSettled(
    athletes.map(async (a) => {
      const stats = await getMonthlyStats(a);
      return { name: a.name, ...stats };
    })
  );

  const riders = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  res.json({ riders });
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
app.listen(PORT, () => {
  console.log(`\n🚴  Cycling Leaderboard running on http://localhost:${PORT}\n`);
});
