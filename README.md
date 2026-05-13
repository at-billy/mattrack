# MATTRACK — Setup Guide

## One-time setup (5 minutes)

### 1. Install dependencies
```bash
cd material-tracker
npm install
```

### 2. Deploy the Convex backend
```bash
npx convex dev
```
This will open a browser to log in / create a free Convex account, then create a project and deploy the backend. Keep this terminal running while developing.

### 3. Get your deployment URL
After `npx convex dev` starts, look for a line like:
```
✔ Convex functions ready!
   CONVEX_URL=https://happy-animal-123.convex.cloud
```
Copy that URL.

### 4. Open the app
Open `index.html` in a browser (double-click or `open index.html`).  
Paste the URL from step 3 into the setup screen and click **Connect**.

---

## Deploying for your team (host it publicly)

### Option A — Netlify (easiest, free)
1. Go to netlify.com → drag & drop the entire `material-tracker/` folder
2. Share the Netlify URL with your team
3. Everyone pastes the same `CONVEX_URL` on first visit (it saves to their browser)

### Option B — GitHub Pages
1. Push the repo to GitHub
2. Enable GitHub Pages on the repo (Settings → Pages → Deploy from branch → main → / root)
3. Share the GitHub Pages URL

> **Note:** The Convex backend runs in the cloud regardless — you only need to host the `index.html` file itself.

---

## Production deploy (when you're done developing)
```bash
npx convex deploy
```
This deploys to your production Convex environment (separate from dev).

---

## Architecture
- **Frontend:** single `index.html` — no framework, no build step, works anywhere
- **Backend:** Convex cloud database — real-time, shared across all users
- **Auth:** custom username/password (SHA-256 hashed, stored in Convex)
- **Sync:** polls every 5 seconds + immediate refresh after any action
