# 🚴 Cycling Leaderboard — Setup Guide

A monthly cycling challenge leaderboard powered by intervals.icu.

---

## What you'll need

- A computer with Node.js installed
- Everyone participating needs a free [intervals.icu](https://intervals.icu) account
- About 10 minutes

---

## Step 1 — Install Node.js (if not already installed)

1. Go to **https://nodejs.org** and download the **LTS** version
2. Run the installer with all defaults
3. Confirm it works by running in Terminal / Command Prompt:
   ```
   node --version
   ```

---

## Step 2 — Install and run the server

```
cd cycling-leaderboard
npm install
npm start
```

Open your browser at **http://localhost:3000** — that's it, the server is running!

No API keys or external app registration needed. intervals.icu uses personal API keys directly.

---

## Step 3 — How colleagues join

Each person who wants to appear on the leaderboard does this once:

1. Log in at **https://intervals.icu**
2. Go to **Settings** (gear icon top right)
3. Scroll to the bottom — find **"Developer Settings"**
4. Note your **Athlete ID** (looks like `i123456`)
5. Click **"Generate API Key"** and copy it
6. Open the leaderboard website
7. Click **"Join the Challenge"**
8. Paste in their Athlete ID and API Key
9. Done — their name appears on the board immediately

> Their API key is stored privately on the server. It's used only to read their cycling activities.

---

## Step 4 — Deploy so everyone can access it

### Option A: Render (free, easiest)
1. Push code to GitHub (see GitHub setup guide)
2. Go to **https://render.com** → New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `npm start`
5. No environment variables needed beyond `PORT` (Render sets this automatically)

### Option B: Railway
Same process — connect GitHub repo, no extra environment variables needed.

### Option C: Raspberry Pi (free forever)
```bash
git clone https://github.com/YOUR_USERNAME/cycling-leaderboard.git
cd cycling-leaderboard
npm install
npm start
```
Use PM2 to keep it running: `pm2 start server.js --name cycling && pm2 save`
Use Cloudflare Tunnel for public access.

---

## Files explained

```
cycling-leaderboard/
├── server.js          ← Backend (intervals.icu API calls + athlete storage)
├── package.json       ← npm dependencies
├── .env.example       ← Environment template (copy to .env)
├── .gitignore         ← Keeps .env and data/ off GitHub
├── SETUP.md           ← This file
├── public/
│   └── index.html     ← The leaderboard website
└── data/
    └── athletes.json  ← Created automatically; stores athlete IDs + API keys
```

---

## Troubleshooting

**"Invalid Athlete ID or API key" on join**
→ Double-check you copied the full API key. Athlete ID should start with "i" followed by numbers.

**Rides not showing**
→ intervals.icu syncs from Garmin/Wahoo/etc. — check that the sync has completed in intervals.icu first.
→ Only activities of type "Ride" are counted. Indoor trainers logged as "VirtualRide" are also included.

**Someone wants to leave**
→ They can revoke their API key in intervals.icu Developer Settings. Their entry stays on the board until the server restarts or you delete `data/athletes.json`.
