# 🚴 Cycling Leaderboard — Setup Guide

This is a complete step-by-step guide to get your cycling leaderboard running. No prior coding experience needed.

---

## What you'll need

- A computer (Mac, Windows, or Linux)
- Node.js installed (free — instructions below)
- A Strava account (free)
- About 20 minutes

---

## Step 1 — Install Node.js

Node.js is the software that runs the server.

1. Go to **https://nodejs.org**
2. Download the **LTS** version (the one that says "Recommended for most users")
3. Run the installer and click through all the defaults
4. To confirm it worked, open a Terminal (Mac: press `Cmd+Space`, type "Terminal") or Command Prompt (Windows: press `Win+R`, type "cmd"), and run:
   ```
   node --version
   ```
   You should see something like `v20.11.0`. If you do, you're good.

---

## Step 2 — Set up a Strava API App

This gives your leaderboard permission to read everyone's activities.

1. Go to **https://www.strava.com/settings/api** (log in if needed)
2. Fill in the form:
   - **Application Name**: `Cycling Leaderboard` (or anything)
   - **Category**: `Other`
   - **Club**: leave blank
   - **Website**: `http://localhost:3000` (you can change this later)
   - **Authorization Callback Domain**: `localhost`
3. Click **Create**
4. You'll see your **Client ID** and **Client Secret** — keep this page open, you'll need these in Step 4

> ⚠️ Never share your Client Secret with anyone.

---

## Step 3 — Get the project files

If you received this as a zip file:
1. Unzip it somewhere easy to find, like your Desktop
2. Open your Terminal / Command Prompt
3. Navigate to the folder:
   ```
   cd Desktop/cycling-leaderboard
   ```

Then install the dependencies (this downloads the packages the app needs):
```
npm install
```

You should see a progress bar and then `added X packages`. That's normal.

---

## Step 4 — Configure your credentials

1. In the `cycling-leaderboard` folder, find the file called `.env.example`
2. Make a **copy** of it and name the copy exactly `.env` (with a dot at the start, no `.example`)
   - On Mac/Linux in Terminal: `cp .env.example .env`
   - On Windows in Command Prompt: `copy .env.example .env`
3. Open `.env` in any text editor (Notepad, TextEdit, VS Code, etc.)
4. Replace the placeholder values:

```
STRAVA_CLIENT_ID=123456          ← put your Client ID here (numbers only)
STRAVA_CLIENT_SECRET=abc123...   ← put your Client Secret here
BASE_URL=http://localhost:3000   ← leave this as-is for now
PORT=3000                        ← leave this as-is
```

5. Save the file.

---

## Step 5 — Run the server

In your Terminal (make sure you're still in the `cycling-leaderboard` folder):

```
npm start
```

You should see:
```
🚴  Cycling Leaderboard running on http://localhost:3000
```

Now open your browser and go to **http://localhost:3000**

You'll see the leaderboard! It'll be empty until people connect their Strava accounts.

---

## Step 6 — Invite your colleagues

Share the URL with your colleagues and tell them to:

1. Go to the website
2. Click **"Join with Strava"**
3. Log in to Strava and click **Authorize**
4. They'll be redirected back and their rides will appear

That's it! Their monthly cycling kilometers will show up on the leaderboard automatically.

---

## Step 7 (Optional) — Put it online so everyone can access it

Right now the site only works on your computer. To make it accessible to everyone:

### Easiest option: Railway (free tier)

1. Go to **https://railway.app** and create a free account
2. Click **New Project → Deploy from GitHub**
   - First, push your code to GitHub: https://github.com/new (create a repo, upload the files)
3. In Railway, click your project → **Variables** and add the same variables from your `.env` file
4. Change `BASE_URL` to your Railway URL (shown in the Railway dashboard under **Domains**)
5. Go back to Strava API settings and update the **Authorization Callback Domain** to your Railway domain

### Alternative: Render, Fly.io, or any VPS

Any Node.js hosting works. The process is the same: upload the files, set the environment variables, and update your Strava callback domain.

---

## Troubleshooting

**"Cannot find module" error when running npm start**
→ Run `npm install` again

**"STRAVA_CLIENT_ID not set" warning**
→ Make sure you created `.env` (not `.env.example`) and filled it in correctly

**"redirect_uri_mismatch" from Strava**
→ The URL in your Strava app settings doesn't match `BASE_URL` in your `.env`. Make sure `Authorization Callback Domain` in Strava matches (just the domain, no `http://` or paths).

**Someone's rides aren't showing up**
→ Strava activities set to "Only You" (private) won't be readable. Ask them to set rides to "Followers" or "Everyone", or re-authorize the app.

**The leaderboard is slow**
→ Normal for large groups — the server fetches from Strava for each person on every refresh. For 10+ people, consider adding caching (ask a developer or open an issue).

---

## How it works (quick overview)

```
Colleague clicks "Join with Strava"
  → Strava login page opens
  → They authorize access
  → Strava sends an auth code to our server
  → Server exchanges it for an access token (saved to data/athletes.json)

When leaderboard loads
  → Frontend asks /api/leaderboard
  → Server fetches this month's activities for each saved athlete
  → Returns sorted list of { name, km, rides }
  → Frontend renders the leaderboard
```

Tokens auto-refresh every 6 hours (Strava's limit) — the server handles this transparently.

---

## Files explained

```
cycling-leaderboard/
├── server.js          ← The backend (handles Strava OAuth + API calls)
├── package.json       ← Lists the npm packages needed
├── .env.example       ← Template for your credentials (copy to .env)
├── .gitignore         ← Tells git to ignore .env and node_modules
├── SETUP.md           ← This file
├── public/
│   └── index.html     ← The leaderboard website (frontend)
└── data/
    └── athletes.json  ← Created automatically; stores athlete tokens
```

---

Questions? The two most important things:
1. Your `.env` file has the right Client ID and Secret
2. The `BASE_URL` matches where the app is actually running
