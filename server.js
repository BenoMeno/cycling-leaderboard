// ─────────────────────────────────────────────────────────────
//  Cycling Leaderboard – Backend Server
//  Strava OAuth + intervals.icu fallback + FIT upload + Turso
// ─────────────────────────────────────────────────────────────
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['1.1.1.1', '8.8.8.8']);

require('dotenv').config();
const express    = require('express');
const axios      = require('axios');
const path       = require('path');
const crypto     = require('crypto');
const multer     = require('multer');
const FitParser  = require('fit-file-parser').default;
const { createClient } = require('@libsql/client');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const {
  PORT = 3000,
  TURSO_URL, TURSO_TOKEN,
  STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET,
  BASE_URL,
  ADMIN_PASSWORD,
} = process.env;

const db = createClient({
  url:       TURSO_URL   || 'file:local.db',
  authToken: TURSO_TOKEN || undefined,
});

// ── Create / migrate tables ───────────────────────────────────
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS athletes (
      athlete_id        TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      api_key           TEXT NOT NULL DEFAULT '',
      remove_code       TEXT NOT NULL DEFAULT '',
      strava_id         TEXT,
      strava_token      TEXT,
      strava_refresh    TEXT,
      strava_expires    INTEGER,
      auth_type         TEXT NOT NULL DEFAULT 'intervals'
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
  // Migrate existing tables that predate new columns
  const migrations = [
    'ALTER TABLE athletes ADD COLUMN remove_code TEXT NOT NULL DEFAULT ""',
    'ALTER TABLE athletes ADD COLUMN strava_id TEXT',
    'ALTER TABLE athletes ADD COLUMN strava_token TEXT',
    'ALTER TABLE athletes ADD COLUMN strava_refresh TEXT',
    'ALTER TABLE athletes ADD COLUMN strava_expires INTEGER',
    'ALTER TABLE athletes ADD COLUMN auth_type TEXT NOT NULL DEFAULT "intervals"',
  ];
  for (const sql of migrations) {
    try { await db.execute(sql); } catch { /* column already exists */ }
  }
  console.log('[db] Tables ready.');
}

// ── Athlete helpers ───────────────────────────────────────────
async function loadAthletes() {
  const r = await db.execute('SELECT * FROM athletes');
  return r.rows.map(mapAthlete);
}

async function getAthlete(athleteId) {
  const r = await db.execute({ sql: 'SELECT * FROM athletes WHERE athlete_id = ?', args: [athleteId] });
  return r.rows[0] ? mapAthlete(r.rows[0]) : null;
}

async function getAthleteByStravaId(stravaId) {
  const r = await db.execute({ sql: 'SELECT * FROM athletes WHERE strava_id = ?', args: [String(stravaId)] });
  return r.rows[0] ? mapAthlete(r.rows[0]) : null;
}

async function getAthleteByRemoveCode(code) {
  const r = await db.execute({ sql: 'SELECT * FROM athletes WHERE remove_code = ?', args: [code] });
  return r.rows[0] ? mapAthlete(r.rows[0]) : null;
}

function mapAthlete(r) {
  return {
    athleteId:     r.athlete_id,
    name:          r.name,
    apiKey:        r.api_key,
    removeCode:    r.remove_code,
    stravaId:      r.strava_id,
    stravaToken:   r.strava_token,
    stravaRefresh: r.strava_refresh,
    stravaExpires: r.strava_expires,
    authType:      r.auth_type || 'intervals',
  };
}

async function saveAthleteStrava(stravaId, name, accessToken, refreshToken, expiresAt, removeCode) {
  const athleteId = `strava_${stravaId}`;
  await db.execute({
    sql:  `INSERT OR REPLACE INTO athletes
           (athlete_id, name, api_key, remove_code, strava_id, strava_token, strava_refresh, strava_expires, auth_type)
           VALUES (?, ?, '', ?, ?, ?, ?, ?, 'strava')`,
    args: [athleteId, name, removeCode, String(stravaId), accessToken, refreshToken, expiresAt],
  });
  return athleteId;
}

async function updateStravaTokens(athleteId, accessToken, refreshToken, expiresAt) {
  await db.execute({
    sql:  'UPDATE athletes SET strava_token=?, strava_refresh=?, strava_expires=? WHERE athlete_id=?',
    args: [accessToken, refreshToken, expiresAt, athleteId],
  });
}

async function deleteAthlete(athleteId) {
  await db.execute({ sql: 'DELETE FROM athletes WHERE athlete_id = ?', args: [athleteId] });
  await db.execute({ sql: 'DELETE FROM fit_activities WHERE athlete_id = ?', args: [athleteId] });
}

// ── Strava token refresh ──────────────────────────────────────
async function getValidStravaToken(athlete) {
  if (Date.now() / 1000 < athlete.stravaExpires - 300) return athlete.stravaToken;
  const { data } = await axios.post('https://www.strava.com/oauth/token', {
    client_id:     STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: athlete.stravaRefresh,
  });
  await updateStravaTokens(athlete.athleteId, data.access_token, data.refresh_token, data.expires_at);
  return data.access_token;
}

// ── Strava activities ─────────────────────────────────────────
async function getStravaActivities(athlete, year, month) {
  const pad     = n => String(n).padStart(2, '0');
  const after   = Math.floor(new Date(`${year}-${pad(month)}-01`).getTime() / 1000);
  const lastDay = new Date(year, month, 0).getDate();
  const before  = Math.floor(new Date(`${year}-${pad(month)}-${lastDay}T23:59:59`).getTime() / 1000);
  const token   = await getValidStravaToken(athlete);

  let page = 1, activities = [];
  const rideTypes = ['Ride','VirtualRide','EBikeRide','GravelRide','MountainBikeRide'];

  while (true) {
    const { data } = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
      headers: { Authorization: `Bearer ${token}` },
      params:  { after, before, per_page: 100, page },
    });
    if (!data.length) break;
    for (const act of data) {
      if (rideTypes.includes(act.type)) {
        activities.push({
          id:           `strava_${act.id}`,
          name:         act.name || 'Ride',
          activityDate: act.start_date_local?.split('T')[0],
          distanceKm:   Math.round(act.distance / 100) / 10,
          elevationM:   Math.round(act.total_elevation_gain || 0),
          durationS:    act.moving_time || 0,
          source:       'strava',
        });
      }
    }
    if (data.length < 100) break;
    page++;
  }
  console.log(`[${athlete.name}] Strava: ${activities.length} rides`);
  return activities;
}



// ── FIT helpers ───────────────────────────────────────────────
async function getFitActivities(athleteId, year, month) {
  const pad     = n => String(n).padStart(2, '0');
  const oldest  = `${year}-${pad(month)}-01`;
  const newest  = `${year}-${pad(month)}-31`;
  const result  = await db.execute({
    sql:  `SELECT id, filename, activity_date, distance_km, elevation_m, duration_s, uploaded_at
           FROM fit_activities WHERE athlete_id=? AND activity_date>=? AND activity_date<=?
           ORDER BY activity_date ASC`,
    args: [athleteId, oldest, newest],
  });
  return result.rows.map(r => ({
    id: r.id, filename: r.filename, activityDate: r.activity_date,
    distanceKm: r.distance_km, elevationM: r.elevation_m,
    durationS: r.duration_s, uploadedAt: r.uploaded_at, source: 'fit',
  }));
}

async function deleteFitActivity(activityId, athleteId) {
  const r = await db.execute({ sql: 'DELETE FROM fit_activities WHERE id=? AND athlete_id=?', args: [activityId, athleteId] });
  return r.rowsAffected > 0;
}

function parseFitFile(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new FitParser({ force: true, speedUnit: 'km/h', lengthUnit: 'km', elapsedRecordField: true });
    parser.parse(buffer, (err, data) => {
      if (err) return reject(err);
      const session = data.activity?.sessions?.[0];
      if (!session) return reject(new Error('No session data found in FIT file'));
      const sport = (session.sport || '').toLowerCase();
      const rideTypes = ['cycling','biking','bike','ride','virtual','gravel','mountain','ebike'];
      if (!rideTypes.some(t => sport.includes(t)) && sport !== '')
        return reject(new Error(`Activity type "${session.sport}" is not a cycling activity`));
      const distanceKm  = session.total_distance || 0;
      const elevationM  = session.total_ascent   || 0;
      const durationS   = session.total_elapsed_time || 0;
      const startTime   = session.start_time ? new Date(session.start_time) : new Date();
      const activityDate = startTime.toISOString().split('T')[0];
      if (distanceKm < 0.1) return reject(new Error('Activity has no distance data'));
      resolve({ distanceKm: Math.round(distanceKm * 10) / 10, elevationM: Math.round(elevationM), durationS: Math.round(durationS), activityDate });
    });
  });
}

// ── Leaderboard ───────────────────────────────────────────────
async function fetchLeaderboard(year, month) {
  const athletes = await loadAthletes();
  if (!athletes.length) return [];

  const results = await Promise.allSettled(
    athletes.map(async (a) => {
      try {
        let sourceActivities = [];
        if (a.authType === 'strava' && a.stravaToken) {
          sourceActivities = await getStravaActivities(a, year, month);
        }
        const fitActivities = await getFitActivities(a.athleteId, year, month);
        const all = [...sourceActivities, ...fitActivities];
        return {
          name:      a.name,
          athleteId: a.athleteId,
          authType:  a.authType,
          km:        Math.round(all.reduce((s, x) => s + x.distanceKm, 0) * 10) / 10,
          elevation: Math.round(all.reduce((s, x) => s + x.elevationM, 0)),
          rides:     all.length,
        };
      } catch (err) {
        console.error(`[${a.name}] Failed:`, err.response?.status, err.message);
        throw err;
      }
    })
  );
  return results.filter(r => r.status === 'fulfilled').map(r => r.value);
}

// ── History / snapshot ────────────────────────────────────────
async function loadHistory() {
  const r = await db.execute('SELECT month, saved_at, riders FROM history ORDER BY month DESC');
  return r.rows.map(row => ({ month: row.month, savedAt: row.saved_at, riders: JSON.parse(row.riders) }));
}
async function saveHistoryEntry(month, savedAt, riders) {
  await db.execute({ sql: 'INSERT OR IGNORE INTO history (month, saved_at, riders) VALUES (?, ?, ?)', args: [month, savedAt, JSON.stringify(riders)] });
}
async function historyEntryExists(month) {
  const r = await db.execute({ sql: 'SELECT 1 FROM history WHERE month=?', args: [month] });
  return r.rows.length > 0;
}
async function snapshotMonth(year, month) {
  const key = `${year}-${String(month).padStart(2,'0')}`;
  if (await historyEntryExists(key)) { console.log(`[snapshot] ${key} already exists.`); return; }
  console.log(`[snapshot] Saving ${key}…`);
  const riders = await fetchLeaderboard(year, month);
  if (!riders.length) { console.log(`[snapshot] No riders, skipping.`); return; }
  await saveHistoryEntry(key, new Date().toISOString(), riders);
  console.log(`[snapshot] Saved ${riders.length} riders for ${key}.`);
}
async function checkMissedSnapshot() {
  const now  = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth(), 0);
  const key  = `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`;
  if (!(await historyEntryExists(key))) await snapshotMonth(prev.getFullYear(), prev.getMonth()+1);
}
let lastCheckedMonth = new Date().getMonth();
setInterval(async () => {
  const now = new Date();
  if (now.getMonth() !== lastCheckedMonth) {
    lastCheckedMonth = now.getMonth();
    const prev = new Date(now.getFullYear(), now.getMonth(), 0);
    await snapshotMonth(prev.getFullYear(), prev.getMonth()+1);
  }
}, 60*60*1000);

// ── Chat helpers ──────────────────────────────────────────────
async function getChatMessages(month) {
  const r = await db.execute({ sql: 'SELECT id,author,message,created_at FROM chat WHERE month=? ORDER BY created_at ASC', args: [month] });
  return r.rows.map(r => ({ id: r.id, author: r.author, message: r.message, createdAt: r.created_at }));
}
async function addChatMessage(month, author, message) {
  const r = await db.execute({ sql: 'INSERT INTO chat (month,author,message,created_at) VALUES (?,?,?,?)', args: [month, author, message.slice(0,500), new Date().toISOString()] });
  return r.lastInsertRowid;
}

// ── Routes ────────────────────────────────────────────────────

// ── Strava OAuth ──────────────────────────────────────────────
app.get('/auth/strava', (req, res) => {
  if (!STRAVA_CLIENT_ID) return res.send('STRAVA_CLIENT_ID not configured.');
  const redirect = `${BASE_URL}/auth/strava/callback`;
  const url = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=read,activity:read`;
  res.redirect(url);
});

app.get('/auth/strava/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=' + encodeURIComponent(error || 'access_denied'));
  try {
    const { data } = await axios.post('https://www.strava.com/oauth/token', {
      client_id:     STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
    });
    const stravaId = data.athlete.id;
    const name     = `${data.athlete.firstname} ${data.athlete.lastname}`;

    // Check if already exists — update tokens, keep existing remove_code
    const existing = await getAthleteByStravaId(stravaId);
    let removeCode = existing?.removeCode || crypto.randomBytes(5).toString('hex');

    await saveAthleteStrava(stravaId, name, data.access_token, data.refresh_token, data.expires_at, removeCode);

    // Pass remove code and name back via URL only if new user
    const isNew = !existing;
    res.redirect(`/?connected=1&name=${encodeURIComponent(name)}&code=${isNew ? removeCode : ''}&new=${isNew}`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// Leave
app.post('/api/leave', async (req, res) => {
  const { removeCode } = req.body;
  if (!removeCode) return res.status(400).json({ error: 'removeCode required' });
  const athlete = await getAthleteByRemoveCode(removeCode);
  if (!athlete) return res.status(404).json({ error: 'Invalid removal code.' });
  await deleteAthlete(athlete.athleteId);
  res.json({ success: true, name: athlete.name });
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  const now    = new Date();
  const riders = await fetchLeaderboard(now.getFullYear(), now.getMonth()+1);
  res.json({ riders });
});

// Athlete activities
app.get('/api/athlete/:id/activities', async (req, res) => {
  const now     = new Date();
  const athlete = await getAthlete(req.params.id);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  let sourceActivities = [];
  try {
    if (athlete.authType === 'strava' && athlete.stravaToken)
      sourceActivities = await getStravaActivities(athlete, now.getFullYear(), now.getMonth()+1);
  } catch (err) { console.error('Activities fetch failed:', err.message); }
  const fitActivities = await getFitActivities(req.params.id, now.getFullYear(), now.getMonth()+1);
  const all = [...sourceActivities, ...fitActivities].sort((a,b) => a.activityDate?.localeCompare(b.activityDate));
  res.json({ name: athlete.name, activities: all });
});

// Upload FIT
app.post('/api/athlete/:id/upload', upload.single('fit'), async (req, res) => {
  const { removeCode } = req.body;
  if (!removeCode) return res.status(400).json({ error: 'removeCode required' });
  const athlete = await getAthlete(req.params.id);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found' });
  if (athlete.removeCode !== removeCode) return res.status(403).json({ error: 'Invalid removal code' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const parsed = await parseFitFile(req.file.buffer);
    await db.execute({
      sql:  'INSERT INTO fit_activities (athlete_id,filename,activity_date,distance_km,elevation_m,duration_s,uploaded_at) VALUES (?,?,?,?,?,?,?)',
      args: [req.params.id, req.file.originalname, parsed.activityDate, parsed.distanceKm, parsed.elevationM, parsed.durationS, new Date().toISOString()],
    });
    res.json({ success: true, activity: { ...parsed, filename: req.file.originalname, source: 'fit' } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete FIT activity
app.delete('/api/activity/:id', async (req, res) => {
  const { removeCode } = req.body;
  if (!removeCode) return res.status(400).json({ error: 'removeCode required' });
  const athlete = await getAthleteByRemoveCode(removeCode);
  if (!athlete) return res.status(403).json({ error: 'Invalid removal code' });
  const deleted = await deleteFitActivity(req.params.id, athlete.athleteId);
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
  const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  res.json(await getChatMessages(month));
});
app.post('/api/chat', async (req, res) => {
  const { author, message } = req.body;
  if (!author?.trim() || !message?.trim()) return res.status(400).json({ error: 'author and message required' });
  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const id    = await addChatMessage(month, author.trim().slice(0,50), message.trim());
  res.json({ success: true, id });
});

// ── Admin ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(403).json({ error: 'ADMIN_PASSWORD not configured.' });
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password.' });
  next();
}
app.get('/api/admin/athletes', requireAdmin, async (req, res) => {
  const r = await db.execute('SELECT athlete_id, name, remove_code, auth_type FROM athletes ORDER BY name');
  res.json(r.rows.map(row => ({ athleteId: row.athlete_id, name: row.name, removeCode: row.remove_code, authType: row.auth_type })));
});
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
