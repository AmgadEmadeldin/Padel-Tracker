# 🎾 Padel Tracker

A phone-first web app for tracking our Saturday padel matches:
Amgad, Omar, Daw, Nader, Mohy and Abdelhameed.

## What it does

- **Add a match** in a few taps: pick two players per team, set the score
  (games, e.g. 6–4), save. The date defaults to today, so you can log every
  match right after it ends.
- **Leaderboard**: a rating for each player (Elo-style: beating a stronger team
  earns more, and a bigger margin counts a bit more), W–L, win %, and last-5
  form. Filter by all time, this month or the last Saturday. ▲▼ shows each
  player's change since the previous Saturday.
- **Rating over time** chart. Tap or drag on it to see the values; tap names in
  the legend to hide or show players.
- **Player pages**: record, game difference, best partner, toughest opponent,
  how they do with and against each player, and recent matches.
- **Insights**: dream team, biggest rivalry, hot streaks, best game difference,
  biggest win, close matches, and a partnership win % heatmap.
- **Matches**: every result grouped by Saturday. Tap a match to edit or
  delete it.

## Sharing with the group

Results are stored **on the phone that enters them** (no accounts, no server).
To keep everyone up to date:

- **More → Share leaderboard link** sends a link (WhatsApp, etc.) that opens
  the full dashboard on anyone's phone, read-only. Send a fresh link after
  each Saturday. If someone else will enter results next time, they can tap
  **Save to this phone** to take over.
- **Matches → Share** (next to a date) sends a text summary of that day's
  results and standings.
- **More → Export / Import** makes a backup file, or moves the data to a new phone.

## Install on your phone

1. Host it (below) and open the link in Safari (iPhone) or Chrome (Android).
2. iPhone: Share → **Add to Home Screen**. Android: ⋮ menu → **Add to Home screen** / **Install app**.

It then opens full-screen like a normal app and works without signal.

## Hosting (free, GitHub Pages)

1. Merge this branch into `main`.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The `Deploy to GitHub Pages` workflow publishes it to
   `https://<your-username>.github.io/Padel-Tracker/`.

To try it locally: `python3 -m http.server` in this folder and open
http://localhost:8000.

## Files

Plain HTML/CSS/JS, no build step: `index.html`, `styles.css`, `app.js`,
plus `manifest.webmanifest`, `sw.js` (offline support) and icons.
