// ─────────────────────────────────────────────────────────────
//  Cycling Leaderboard – Backend Server
//  intervals.icu API + Turso (persistent SQLite in the cloud)
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const path       = require('path');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { PORT = 3000, TURSO_URL, TURSO_TOKEN } = process.env;

// ── Turso database client ─────────────────────────────────────
const db = createClient({
  url:       TURSO_URL   || 'file:local.db',  // falls back to local SQLite for dev
  authToken: TURSO_TOKEN || undefined,
});

// ── Create tables if they don't exist ────────────────────────
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS athletes (
      athlete_id TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      api_key    TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS history (
      month    TEXT PRIMARY KEY,
      saved_at TEXT NOT NULL,
      riders   TEXT NOT NULL
    )
  `);
  console.log('[db] Tables ready.');
}

// ── Athlete helpers ───────────────────────────────────────────
async function loadAthletes() {
  const result = await db.execute('SELECT athlete_id, name, api_key FROM athletes');
  return result.rows.map(r => ({ athleteId: r.athlete_id, name: r.name, apiKey: r.api_key }));
}

async function saveAthlete(athleteId, name, apiKey) {
  await db.execute({
    sql: 'INSERT OR REPLACE INTO athletes (athlete_id, name, api_key) VALUES (?, ?, ?)',
    args: [athleteId, name, apiKey],
  });
}

async function deleteAthlete(athleteId) {
  await db.execute({ sql: 'DELETE FROM athletes WHERE athlete_id = ?', args: [athleteId] });
}

// ── History helpers ───────────────────────────────────────────
async function loadHistory() {
  const result = await db.execute('SELECT month, saved_at, riders FROM history ORDER BY month DESC');
  return result.rows.map(r => ({
    month:   r.month,
    savedAt: r.saved_at,
    riders:  JSON.parse(r.riders),
  }));
}

async function saveHistoryEntry(month, savedAt, riders) {
  await db.execute({
    sql:  'INSERT OR IGNORE INTO history (month, saved_at, riders) VALUES (?, ?, ?)',
    args: [month, savedAt, JSON.stringify(riders)],
  });
}

async function historyEntryExists(month) {
  const result = await db.execute({ sql: 'SELECT 1 FROM history WHERE month = ?', args: [month] });
  return result.rows.length > 0;
}

// ── Fetch athlete profile from intervals.icu ──────────────────
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
  console.log(`[${athlete.name}] Fetching ${oldest} → ${newest}`);

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
  const athletes = await loadAthletes();
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

  return results.filter(r => r.status === 'fulfilled').map(r => r.value);
}

// ── Snapshot: save final standings for a completed month ──────
async function snapshotMonth(year, month) {
  const key = `${year}-${String(month).padStart(2, '0')}`;

  if (await historyEntryExists(key)) {
    console.log(`[snapshot] ${key} already exists, skipping.`);
    return;
  }

  console.log(`[snapshot] Saving standings for ${key}…`);
  const riders = await fetchLeaderboard(year, month);

  if (riders.length === 0) {
    console.log(`[snapshot] No riders for ${key}, skipping.`);
    return;
  }

  await saveHistoryEntry(key, new Date().toISOString(), riders);
  console.log(`[snapshot] Saved ${riders.length} riders for ${key}.`);
}

// ── Check on startup if last month needs snapshotting ─────────
async function checkMissedSnapshot() {
  const now       = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
  const year      = lastMonth.getFullYear();
  const month     = lastMonth.getMonth() + 1;
  const key       = `${year}-${String(month).padStart(2, '0')}`;

  if (!(await historyEntryExists(key))) {
    console.log(`[snapshot] Missing snapshot for ${key}, creating now…`);
    await snapshotMonth(year, month);
  }
}

// ── Schedule end-of-month snapshot (checks every hour) ───────
let lastCheckedMonth = new Date().getMonth();
setInterval(async () => {
  const now = new Date();
  if (now.getMonth() !== lastCheckedMonth) {
    lastCheckedMonth = now.getMonth();
    const prev = new Date(now.getFullYear(), now.getMonth(), 0);
    await snapshotMonth(prev.getFullYear(), prev.getMonth() + 1);
  }
}, 60 * 60 * 1000);

// ── Routes ────────────────────────────────────────────────────

// Register a new athlete
app.post('/api/join', async (req, res) => {
  const { athleteId, apiKey } = req.body;
  if (!athleteId || !apiKey)
    return res.status(400).json({ error: 'athleteId and apiKey are required' });

  try {
    const profile     = await getAthleteProfile(athleteId, apiKey);
    const displayName = profile.name || `Athlete ${athleteId}`;
    await saveAthlete(athleteId, displayName, apiKey);
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
app.get('/api/history', async (req, res) => {
  res.json(await loadHistory());
});

// Manually trigger a snapshot (admin use)
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
  deleteAthlete(req.params.id)
    .then(() => res.json({ success: true }))
    .catch(() => res.status(500).json({ error: 'Failed to delete' }));
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚴  Cycling Leaderboard running on http://localhost:${PORT}\n`);
  await initDB();
  await checkMissedSnapshot();
});
