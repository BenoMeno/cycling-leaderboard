// ─────────────────────────────────────────────────────────────
//  Cycling Leaderboard – Backend Server
//  intervals.icu API + FIT file upload + Turso
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const path       = require('path');
const crypto     = require('crypto');
const multer     = require('multer');
const FitParser  = require('fit-file-parser').default;
const { createClient } = require('@libsql/client');

const app     = express();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { PORT = 3000, TURSO_URL, TURSO_TOKEN } = process.env;

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
  await db.execute(`
    CREATE TABLE IF NOT EXISTS fit_activities (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      athlete_id    TEXT NOT NULL,
      filename      TEXT NOT NULL,
      activity_date TEXT NOT NULL,
      distance_km   REAL NOT NULL,
      elevation_m   REAL NOT NULL,
      duration_s    INTEGER,
      uploaded_at   TEXT NOT NULL
    )
  `);
  try { await db.execute('ALTER TABLE athletes ADD COLUMN remove_code TEXT NOT NULL DEFAULT ""'); } catch {}
  console.log('[db] Tables ready.');
}

// ── Athlete helpers ───────────────────────────────────────────
async function loadAthletes() {
  const result = await db.execute('SELECT athlete_id, name, api_key, remove_code FROM athletes');
  return result.rows.map(r => ({ athleteId: r.athlete_id, name: r.name, apiKey: r.api_key, removeCode: r.remove_code }));
}

async function getAthlete(athleteId) {
  const result = await db.execute({ sql: 'SELECT * FROM athletes WHERE athlete_id = ?', args: [athleteId] });
  if (!result.rows[0]) return null;
  const r = result.rows[0];
  return { athleteId: r.athlete_id, name: r.name, apiKey: r.api_key, removeCode: r.remove_code };
}

async function saveAthlete(athleteId, name, apiKey, removeCode) {
  await db.execute({
    sql:  'INSERT OR REPLACE INTO athletes (athlete_id, name, api_key, remove_code) VALUES (?, ?, ?, ?)',
    args: [athleteId, name, apiKey, removeCode],
  });
}

async function getAthleteByRemoveCode(code) {
  const result = await db.execute({ sql: 'SELECT athlete_id, name FROM athletes WHERE remove_code = ?', args: [code] });
  return result.rows[0] || null;
}

async function deleteAthlete(athleteId) {
  await db.execute({ sql: 'DELETE FROM athletes WHERE athlete_id = ?', args: [athleteId] });
  await db.execute({ sql: 'DELETE FROM fit_activities WHERE athlete_id = ?', args: [athleteId] });
}

// ── FIT activity helpers ──────────────────────────────────────
async function getFitActivities(athleteId, year, month) {
  const pad     = n => String(n).padStart(2, '0');
  const oldest  = `${year}-${pad(month)}-01`;
  const newest  = `${year}-${pad(month)}-31`;
  const result  = await db.execute({
    sql:  `SELECT id, filename, activity_date, distance_km, elevation_m, duration_s, uploaded_at
           FROM fit_activities
           WHERE athlete_id = ? AND activity_date >= ? AND activity_date <= ?
           ORDER BY activity_date ASC`,
    args: [athleteId, oldest, newest],
  });
  return result.rows.map(r => ({
    id:           r.id,
    filename:     r.filename,
    activityDate: r.activity_date,
    distanceKm:   r.distance_km,
    elevationM:   r.elevation_m,
    durationS:    r.duration_s,
    uploadedAt:   r.uploaded_at,
    source:       'fit',
  }));
}

async function getAllFitActivitiesForMonth(year, month) {
  const pad    = n => String(n).padStart(2, '0');
  const oldest = `${year}-${pad(month)}-01`;
  const newest = `${year}-${pad(month)}-31`;
  const result = await db.execute({
    sql:  `SELECT f.id, f.athlete_id, f.filename, f.activity_date, f.distance_km, f.elevation_m, f.duration_s, f.uploaded_at, a.name
           FROM fit_activities f JOIN athletes a ON f.athlete_id = a.athlete_id
           WHERE f.activity_date >= ? AND f.activity_date <= ?`,
    args: [oldest, newest],
  });
  return result.rows.map(r => ({
    id: r.id, athleteId: r.athlete_id, name: r.name,
    filename: r.filename, activityDate: r.activity_date,
    distanceKm: r.distance_km, elevationM: r.elevation_m,
    durationS: r.duration_s, uploadedAt: r.uploaded_at,
  }));
}

async function deleteFitActivity(activityId, athleteId) {
  // Only delete if this activity belongs to the given athlete
  const result = await db.execute({
    sql:  'DELETE FROM fit_activities WHERE id = ? AND athlete_id = ?',
    args: [activityId, athleteId],
  });
  return result.rowsAffected > 0;
}

// ── FIT file parser ───────────────────────────────────────────
function parseFitFile(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new FitParser({ force: true, speedUnit: 'km/h', lengthUnit: 'km', elapsedRecordField: true });
    parser.parse(buffer, (err, data) => {
      if (err) return reject(err);

      const session = data.activity?.sessions?.[0];
      if (!session) return reject(new Error('No session data found in FIT file'));

      const sport = (session.sport || '').toLowerCase();
      const rideTypes = ['cycling', 'biking', 'bike', 'ride', 'virtual', 'gravel', 'mountain', 'ebike'];
      if (!rideTypes.some(t => sport.includes(t)) && sport !== '') {
        return reject(new Error(`Activity type "${session.sport}" is not a cycling activity`));
      }

      const distanceKm  = session.total_distance ? (session.total_distance) : 0;
      const elevationM  = session.total_ascent   ? session.total_ascent     : 0;
      const durationS   = session.total_elapsed_time || 0;
      const startTime   = session.start_time ? new Date(session.start_time) : new Date();
      const activityDate = startTime.toISOString().split('T')[0];

      if (distanceKm < 0.1) return reject(new Error('Activity has no distance data'));

      resolve({ distanceKm: Math.round(distanceKm * 10) / 10, elevationM: Math.round(elevationM), durationS: Math.round(durationS), activityDate });
    });
  });
}

// ── History helpers ───────────────────────────────────────────
async function loadHistory() {
  const result = await db.execute('SELECT month, saved_at, riders FROM history ORDER BY month DESC');
  return result.rows.map(r => ({ month: r.month, savedAt: r.saved_at, riders: JSON.parse(r.riders) }));
}
async function saveHistoryEntry(month, savedAt, riders) {
  await db.execute({ sql: 'INSERT OR IGNORE INTO history (month, saved_at, riders) VALUES (?, ?, ?)', args: [month, savedAt, JSON.stringify(riders)] });
}
async function historyEntryExists(month) {
  const result = await db.execute({ sql: 'SELECT 1 FROM history WHERE month = ?', args: [month] });
  return result.rows.length > 0;
}

// ── Chat helpers ──────────────────────────────────────────────
async function getChatMessages(month) {
  const result = await db.execute({ sql: 'SELECT id, author, message, created_at FROM chat WHERE month = ? ORDER BY created_at ASC', args: [month] });
  return result.rows.map(r => ({ id: r.id, author: r.author, message: r.message, createdAt: r.created_at }));
}
async function addChatMessage(month, author, message) {
  const result = await db.execute({ sql: 'INSERT INTO chat (month, author, message, created_at) VALUES (?, ?, ?, ?)', args: [month, author, message.slice(0, 500), new Date().toISOString()] });
  return result.lastInsertRowid;
}

// ── intervals.icu helpers ─────────────────────────────────────
async function getAthleteProfile(athleteId, apiKey) {
  const { data } = await axios.get(`https://intervals.icu/api/v1/athlete/${athleteId}`, { auth: { username: 'API_KEY', password: apiKey } });
  return data;
}

async function getIntervalsActivities(athlete, year, month) {
  const pad     = n => String(n).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  const oldest  = `${year}-${pad(month)}-01`;
  const newest  = `${year}-${pad(month)}-${lastDay}`;

  const { data } = await axios.get(
    `https://intervals.icu/api/v1/athlete/${athlete.athleteId}/activities`,
    { auth: { username: 'API_KEY', password: athlete.apiKey }, params: { oldest, newest } }
  );

  if (data.length > 0) console.log(`[${athlete.name}] First activity raw:`, JSON.stringify(data[0]).slice(0, 300));

  const rideTypes = ['ride', 'virtual', 'ebike', 'gravel', 'mountain', 'cycling', 'bike', 'velomobile'];
  const activities = [];

  for (const act of data) {
    const type = ((act.type || act.sport_type || '')).toLowerCase();
    if (rideTypes.some(t => type.includes(t))) {
      activities.push({
        id:           `icu_${act.id}`,
        name:         act.name || 'Ride',
        activityDate: (act.start_date_local || '').split('T')[0],
        distanceKm:   Math.round((act.distance || 0) / 100) / 10,
        elevationM:   Math.round(act.total_elevation_gain || 0),
        durationS:    act.moving_time || act.elapsed_time || 0,
        source:       'intervals',
      });
    }
  }

  return activities;
}

// ── Leaderboard calculation ───────────────────────────────────
async function fetchLeaderboard(year, month) {
  const athletes = await loadAthletes();
  if (athletes.length === 0) return [];

  const results = await Promise.allSettled(
    athletes.map(async (a) => {
      try {
        // Get intervals.icu activities (skip if no apiKey)
        let intervalsActivities = [];
        if (a.apiKey) {
          try {
            intervalsActivities = await getIntervalsActivities(a, year, month);
          } catch (err) {
            console.error(`[${a.name}] intervals.icu failed:`, err.response?.status, err.message);
          }
        }

        // Get FIT uploaded activities
        const fitActivities = await getFitActivities(a.athleteId, year, month);

        const allActivities = [...intervalsActivities, ...fitActivities];
        const km        = Math.round(allActivities.reduce((s, a) => s + a.distanceKm, 0) * 10) / 10;
        const elevation = Math.round(allActivities.reduce((s, a) => s + a.elevationM, 0));
        const rides     = allActivities.length;

        console.log(`[${a.name}] Total: ${km} km, ${elevation} m, ${rides} rides (${intervalsActivities.length} from intervals, ${fitActivities.length} from FIT)`);
        return { name: a.name, athleteId: a.athleteId, km, elevation, rides };
      } catch (err) {
        console.error(`[${a.name}] Failed:`, err.message);
        throw err;
      }
    })
  );

  return results.filter(r => r.status === 'fulfilled').map(r => r.value);
}

// ── Snapshot helpers ──────────────────────────────────────────
async function snapshotMonth(year, month) {
  const key = `${year}-${String(month).padStart(2, '0')}`;
  if (await historyEntryExists(key)) { console.log(`[snapshot] ${key} already exists.`); return; }
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
  if (!athleteId) return res.status(400).json({ error: 'athleteId is required' });
  try {
    let displayName;
    if (apiKey) {
      const profile = await getAthleteProfile(athleteId, apiKey);
      displayName   = profile.name || `Athlete ${athleteId}`;
    } else {
      // Join without API key (FIT-only mode)
      displayName = req.body.name;
      if (!displayName) return res.status(400).json({ error: 'name is required when joining without API key' });
    }
    const removeCode = crypto.randomBytes(5).toString('hex');
    await saveAthlete(athleteId, displayName, apiKey || '', removeCode);
    res.json({ success: true, name: displayName, removeCode });
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403)
      return res.status(401).json({ error: 'Invalid Athlete ID or API key — check your credentials.' });
    console.error('Join error:', err.message);
    res.status(500).json({ error: 'Could not connect to intervals.icu. Please try again.' });
  }
});

// Leave
app.post('/api/leave', async (req, res) => {
  const { removeCode } = req.body;
  if (!removeCode) return res.status(400).json({ error: 'removeCode required' });
  const athlete = await getAthleteByRemoveCode(removeCode);
  if (!athlete) return res.status(404).json({ error: 'Invalid removal code. Check you copied it correctly.' });
  await deleteAthlete(athlete.athlete_id);
  res.json({ success: true, name: athlete.name });
});

// Current leaderboard
app.get('/api/leaderboard', async (req, res) => {
  const now    = new Date();
  const riders = await fetchLeaderboard(now.getFullYear(), now.getMonth() + 1);
  res.json({ riders });
});

// Get activities for a specific athlete (for the profile modal)
app.get('/api/athlete/:id/activities', async (req, res) => {
  const now      = new Date();
  const year     = now.getFullYear();
  const month    = now.getMonth() + 1;
  const athlete  = await getAthlete(req.params.id);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });

  let intervalsActivities = [];
  if (athlete.apiKey) {
    try { intervalsActivities = await getIntervalsActivities(athlete, year, month); }
    catch (err) { console.error(`Activities fetch failed:`, err.message); }
  }
  const fitActivities = await getFitActivities(req.params.id, year, month);

  // Sort all activities by date
  const all = [...intervalsActivities, ...fitActivities].sort((a, b) => a.activityDate.localeCompare(b.activityDate));
  res.json({ name: athlete.name, activities: all });
});

// Upload FIT file for an athlete
app.post('/api/athlete/:id/upload', upload.single('fit'), async (req, res) => {
  const { removeCode } = req.body;
  if (!removeCode) return res.status(400).json({ error: 'removeCode required to upload' });

  const athlete = await getAthlete(req.params.id);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  if (athlete.removeCode !== removeCode) return res.status(403).json({ error: 'Invalid removal code' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const parsed = await parseFitFile(req.file.buffer);
    await db.execute({
      sql:  'INSERT INTO fit_activities (athlete_id, filename, activity_date, distance_km, elevation_m, duration_s, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [req.params.id, req.file.originalname, parsed.activityDate, parsed.distanceKm, parsed.elevationM, parsed.durationS, new Date().toISOString()],
    });
    res.json({ success: true, activity: { ...parsed, filename: req.file.originalname, source: 'fit' } });
  } catch (err) {
    console.error('FIT parse error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Delete a FIT activity
app.delete('/api/activity/:id', async (req, res) => {
  const { removeCode } = req.body;
  if (!removeCode) return res.status(400).json({ error: 'removeCode required' });

  const athlete = await getAthleteByRemoveCode(removeCode);
  if (!athlete) return res.status(403).json({ error: 'Invalid removal code' });

  const deleted = await deleteFitActivity(req.params.id, athlete.athlete_id);
  if (!deleted) return res.status(404).json({ error: 'Activity not found or does not belong to you' });
  res.json({ success: true });
});

// History
app.get('/api/history', async (req, res) => { res.json(await loadHistory()); });

// Manual snapshot
app.post('/api/snapshot', async (req, res) => {
  const { year, month } = req.body;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  try { await snapshotMonth(year, month); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Chat
app.get('/api/chat', async (req, res) => {
  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  res.json(await getChatMessages(month));
});
app.post('/api/chat', async (req, res) => {
  const { author, message } = req.body;
  if (!author?.trim() || !message?.trim()) return res.status(400).json({ error: 'author and message required' });
  if (message.length > 500) return res.status(400).json({ error: 'Message too long' });
  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const id    = await addChatMessage(month, author.trim().slice(0, 50), message.trim());
  res.json({ success: true, id });
});


// ── Admin routes (password protected) ────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(403).json({ error: 'ADMIN_PASSWORD not configured on server.' });
  const auth = req.headers['x-admin-password'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password.' });
  next();
}

// List all athletes with their codes
app.get('/api/admin/athletes', requireAdmin, async (req, res) => {
  const result = await db.execute('SELECT athlete_id, name, remove_code FROM athletes ORDER BY name');
  res.json(result.rows.map(r => ({ athleteId: r.athlete_id, name: r.name, removeCode: r.remove_code })));
});

// Admin force-delete an athlete
app.delete('/api/admin/athlete/:id', requireAdmin, async (req, res) => {
  const athlete = await getAthlete(req.params.id);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  await deleteAthlete(req.params.id);
  res.json({ success: true, name: athlete.name });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚴  Cycling Leaderboard running on http://localhost:${PORT}\n`);
  await initDB();
  await checkMissedSnapshot();
});
