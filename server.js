// ─────────────────────────────────────────────────────────────
//  Cycling Leaderboard – Backend Server
//  intervals.icu API + Turso (persistent SQLite in the cloud)
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const path       = require('path');
const crypto     = require('crypto');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { PORT = 3000, TURSO_URL, TURSO_TOKEN } = process.env;

// ── Turso database client ─────────────────────────────────────
const db = createClient({
  url:       TURSO_URL   || 'file:local.db',
  authToken: TURSO_TOKEN || undefined,
});

// ── Create tables ─────────────────────────────────────────────
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS athletes (
      athlete_id  TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      api_key     TEXT NOT NULL,
      remove_code TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS history (
      month    TEXT PRIMARY KEY,
      saved_at TEXT NOT NULL,
      riders   TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS chat (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      month      TEXT NOT NULL,
      author     TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  // Add remove_code column to existing deployments that predate it
  try {
    await db.execute('ALTER TABLE athletes ADD COLUMN remove_code TEXT NOT NULL DEFAULT ""');
  } catch { /* column already exists */ }
  console.log('[db] Tables ready.');
}

// ── Athlete helpers ───────────────────────────────────────────
async function loadAthletes() {
  const result = await db.execute('SELECT athlete_id, name, api_key FROM athletes');
  return result.rows.map(r => ({ athleteId: r.athlete_id, name: r.name, apiKey: r.api_key }));
}

async function saveAthlete(athleteId, name, apiKey, removeCode) {
  await db.execute({
    sql:  'INSERT OR REPLACE INTO athletes (athlete_id, name, api_key, remove_code) VALUES (?, ?, ?, ?)',
    args: [athleteId, name, apiKey, removeCode],
  });
}

async function getAthleteByRemoveCode(code) {
  const result = await db.execute({
    sql:  'SELECT athlete_id, name FROM athletes WHERE remove_code = ?',
    args: [code],
  });
  return result.rows[0] || null;
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

// ── Chat helpers ──────────────────────────────────────────────
async function getChatMessages(month) {
  const result = await db.execute({
    sql:  'SELECT id, author, message, created_at FROM chat WHERE month = ? ORDER BY created_at ASC',
    args: [month],
  });
  return result.rows.map(r => ({
    id:        r.id,
    author:    r.author,
    message:   r.message,
    createdAt: r.created_at,
  }));
}

async function addChatMessage(month, author, message) {
  const result = await db.execute({
    sql:  'INSERT INTO chat (month, author, message, created_at) VALUES (?, ?, ?, ?)',
    args: [month, author, message.slice(0, 500), new Date().toISOString()],
  });
  return result.lastInsertRowid;
}

// ── intervals.icu helpers ────────────────────────────────────
async function getAthleteProfile(athleteId, apiKey) {
  const { data } = await axios.get(
    `https://intervals.icu/api/v1/athlete/${athleteId}`,
    { auth: { username: 'API_KEY', password: apiKey } }
  );
  return data;
}

async function getMonthlyStats(athlete, year, month) {
  const pad     = n => String(n).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  const oldest  = `${year}-${pad(month)}-01`;
  const newest  = `${year}-${pad(month)}-${lastDay}`;
  console.log(`[${athlete.name}] Fetching ${oldest} → ${newest}`);

  const { data } = await axios.get(
    `https://intervals.icu/api/v1/athlete/${athlete.athleteId}/activities`,
    {
      auth:   { username: 'API_KEY', password: athlete.apiKey },
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

// ── Snapshot helpers ──────────────────────────────────────────
async function snapshotMonth(year, month) {
  const key = `${year}-${String(month).padStart(2, '0')}`;
  if (await historyEntryExists(key)) {
    console.log(`[snapshot] ${key} already exists.`); return;
  }
  console.log(`[snapshot] Saving standings for ${key}…`);
  const riders = await fetchLeaderboard(year, month);
  if (riders.length === 0) { console.log(`[snapshot] No riders, skipping.`); return; }
  await saveHistoryEntry(key, new Date().toISOString(), riders);
  console.log(`[snapshot] Saved ${riders.length} riders for ${key}.`);
}

async function checkMissedSnapshot() {
  const now  = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth(), 0);
  const key  = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  if (!(await historyEntryExists(key))) {
    console.log(`[snapshot] Missing ${key}, creating now…`);
    await snapshotMonth(prev.getFullYear(), prev.getMonth() + 1);
  }
}

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

// Join
app.post('/api/join', async (req, res) => {
  const { athleteId, apiKey } = req.body;
  if (!athleteId || !apiKey)
    return res.status(400).json({ error: 'athleteId and apiKey are required' });
  try {
    const profile     = await getAthleteProfile(athleteId, apiKey);
    const displayName = profile.name || `Athlete ${athleteId}`;
    const removeCode  = crypto.randomBytes(5).toString('hex'); // e.g. "a3f9c2b1d4"
    await saveAthlete(athleteId, displayName, apiKey, removeCode);
    // Return the removal code to the frontend — user must save it
    res.json({ success: true, name: displayName, removeCode });
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403)
      return res.status(401).json({ error: 'Invalid Athlete ID or API key — check your credentials.' });
    console.error('Join error:', err.message);
    res.status(500).json({ error: 'Could not connect to intervals.icu. Please try again.' });
  }
});

// Leave (remove yourself using your removal code)
app.post('/api/leave', async (req, res) => {
  const { removeCode } = req.body;
  if (!removeCode)
    return res.status(400).json({ error: 'removeCode required' });
  const athlete = await getAthleteByRemoveCode(removeCode);
  if (!athlete)
    return res.status(404).json({ error: 'Invalid removal code. Check you copied it correctly.' });
  await deleteAthlete(athlete.athlete_id);
  res.json({ success: true, name: athlete.name });
});

// Current leaderboard
app.get('/api/leaderboard', async (req, res) => {
  const now    = new Date();
  const riders = await fetchLeaderboard(now.getFullYear(), now.getMonth() + 1);
  res.json({ riders });
});

// History
app.get('/api/history', async (req, res) => {
  res.json(await loadHistory());
});

// Manual snapshot
app.post('/api/snapshot', async (req, res) => {
  const { year, month } = req.body;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  try { await snapshotMonth(year, month); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Chat — get messages for current month
app.get('/api/chat', async (req, res) => {
  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  res.json(await getChatMessages(month));
});

// Chat — post a message
app.post('/api/chat', async (req, res) => {
  const { author, message } = req.body;
  if (!author?.trim() || !message?.trim())
    return res.status(400).json({ error: 'author and message required' });
  if (message.length > 500)
    return res.status(400).json({ error: 'Message too long (max 500 chars)' });
  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const id    = await addChatMessage(month, author.trim().slice(0, 50), message.trim());
  res.json({ success: true, id });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚴  Cycling Leaderboard running on http://localhost:${PORT}\n`);
  await initDB();
  await checkMissedSnapshot();
});
