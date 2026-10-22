# Zoomly — Public App

Zoomly is a social video app combining TikTok-style short videos, YouTube-style
browsing, and Facebook-style following — with a built-in referral system and a
JazzCash coin system. Express server + React client + Turso (libsql) database,
deployable on Render's free tier. Same proven stack as the SMM panel.

## Features

- **Accounts** — sign up / log in with username + password (PBKDF2-hashed),
  30-day sessions, log out.
- **Profiles** — display name, bio, and a profile photo (DP) shown as the
  avatar everywhere: feed, comments, People, profiles and leaderboards.
  Falls back to an initial-letter avatar.
- **Videos** — upload a video (title + description), full-screen vertical
  feed with **For You** and **Following** streams (autoplay, tap to
  pause, double-tap to like), Watch/browse page with search, likes,
  comments, follow/unfollow, People directory, profile pages with stats
  and a video grid, delete your own videos.
- **Referral system** — every user gets a personal code (`ZOOM-<id>-<USERNAME>`)
  to copy/share from the Rewards tab. A new user can enter a code at signup
  or claim one later: the inviter gets **+25 coins**, the new user gets
  **+10 welcome coins**. Profiles show referral count and "my referrals".
- **Coin system** — coin balance per user. The Buy Coins page shows the
  owner's JazzCash number **03266040350** (Muhammad Sajeel) and 5 packs:
  100 coins/Rs.100 · 550/Rs.500 · 1,150/Rs.1,000 · 6,000/Rs.5,000 ·
  14,000/Rs.10,000. The buyer submits the JazzCash **TID** to create a
  request (a TID can only be used once — duplicates are rejected). The
  owner reviews requests in the app (Rewards → Owner section): **Approve**
  credits the coins, **Reject** closes the request.
- **Coin levels** (by balance, shown as a badge with a progress bar):
  Starter 0–99 · Bronze 100–499 · Silver 500–1,499 · Golden 1,500–4,999 ·
  Platinum 5,000–13,999 · Diamond 14,000+.
- **Leaderboards** — visible to every logged-in user: **Top Coins** and
  **Top Referrals**, each capped at the **top 50**, showing rank, DP, name,
  @username, numeric user ID, tier badge and coins/referrals.
- **Admin** — the account whose username matches the `ADMIN_USERNAME` env
  var can review coin requests. Sign up with that exact username right
  after deploying to claim the owner account.

## Media storage — Cloudinary (important)

Videos and profile photos are stored on **Cloudinary** (free tier), never on
the server's disk — Render's disk is ephemeral and files would vanish on
every restart/deploy. Uploads require these env vars:

```
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
```

Without them, uploads fail with a clear "not configured" message (nothing is
silently stored locally). Get the keys from the Cloudinary dashboard after a
free signup at https://cloudinary.com.

## Run locally

```bash
npm install
npm run build          # builds the React client into client/dist
# local DB defaults to file:./data/local.db — no setup needed
ADMIN_USERNAME=sajeel PORT=3100 npm start
# open http://localhost:3100
```

Optional: copy `.env.example` to `.env` and fill in values (the server reads
environment variables; a `.env` file is only for your own tooling — export
the vars or set them inline as above).

Smoke test (server already running):

```bash
BASE_URL=http://localhost:3100 ADMIN_USERNAME=sajeel npm run smoke
```

## Deploy checklist (owner steps)

1. **Turso database** (free) — sign up at https://turso.tech, create a
   database (e.g. `zoomly`), and note its `libsql://…` URL and an auth token:
   `turso db show zoomly --url` and `turso db tokens create zoomly`.
   (You may also reuse the SMM panel's Turso account — a separate database
   is cleaner.)
2. **Cloudinary** (free) — sign up at https://cloudinary.com and copy the
   Cloud name, API Key and API Secret from the Dashboard.
3. **GitHub** — create a new repository, push this folder to it:
   ```bash
   git remote add origin https://github.com/<you>/zoomly-app.git
   git push -u origin main
   ```
4. **Render** — New → **Blueprint**, connect the repo (it uses
   `render.yaml`), then set the env vars in the Render dashboard:
   - `TURSO_DATABASE_URL` — the `libsql://…` URL from step 1
   - `TURSO_AUTH_TOKEN` — the token from step 1 (secret)
   - `ADMIN_USERNAME` — your owner username, e.g. `sajeel`
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
     — from step 2
5. **Deploy.** Render runs `npm install && npm run build`, then `npm start`.
   Health check: `/api/health`.
6. **Claim the owner account** — open the live URL and sign up with the
   exact `ADMIN_USERNAME` username before anyone else takes it. The Owner
   section (coin request approvals) appears for that account under Rewards.

## Notes

- Free Render services sleep when idle; the first visit after a nap can
  take ~30–60 seconds to wake. Normal for the free tier.
- No real secrets live in this repo — all credentials come from env vars.
  The JazzCash number in the app is the owner's public business number,
  shown to buyers on purpose (overridable via `JAZZCASH_NUMBER` /
  `JAZZCASH_TITLE`).
