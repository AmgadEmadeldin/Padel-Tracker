'use strict';

/* ==========================================================================
   Padel Tracker — a phone-first score tracker for a weekly padel group.
   All data lives in this device's localStorage. Results can be shared as a
   read-only link or as a WhatsApp-friendly summary, and backed up as JSON.
   ========================================================================== */

const STORE_KEY = 'padel-tracker-v1';
const DEFAULT_PLAYERS = ['Amgad', 'Omar', 'Daw', 'Nader', 'Mohy', 'Abdelhameed'];
const START_RATING = 1000;
const K_FACTOR = 32;
const MIN_PAIR_GAMES = 2;

/* ---------- Storage ---------- */

function emptyDb() {
  return { players: [...DEFAULT_PLAYERS], matches: [] };
}

function loadDb() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return emptyDb();
    const parsed = JSON.parse(raw);
    return normalizeDb(parsed);
  } catch {
    return emptyDb();
  }
}

function saveDb() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch {
    toast('Could not save on this device');
  }
}

function normalizeDb(obj) {
  if (!obj || !Array.isArray(obj.matches)) throw new Error('Invalid data');
  const players = Array.isArray(obj.players) && obj.players.length ? obj.players.map(String) : [...DEFAULT_PLAYERS];
  const matches = obj.matches
    .filter(m => m && Array.isArray(m.a) && Array.isArray(m.b) && m.a.length === 2 && m.b.length === 2)
    .map(m => ({
      id: String(m.id || uid()),
      date: String(m.date),
      t: Number(m.t) || 0,
      a: m.a.map(String),
      b: m.b.map(String),
      sa: Number(m.sa) || 0,
      sb: Number(m.sb) || 0,
    }));
  // Any name used in a match must be a known player.
  for (const m of matches) {
    for (const p of [...m.a, ...m.b]) if (!players.includes(p)) players.push(p);
  }
  return { players, matches };
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------- App state ---------- */

let db = loadDb();
let snapshot = null;          // read-only data opened from a shared link
let route = { view: 'dashboard' };
let period = 'all';           // dashboard filter: all | month | session
let draft = null;             // add/edit game form state
let hiddenSeries = new Set(); // rating chart legend toggles

const data = () => snapshot || db;
const readOnly = () => !!snapshot;

/* ---------- Helpers ---------- */

const $ = sel => document.querySelector(sel);

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(s, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return parseDate(s).toLocaleDateString(undefined, opts);
}

function fmtShort(s) {
  return parseDate(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function pct(w, n) {
  return n ? Math.round((w / n) * 100) : 0;
}

function colorOf(name) {
  const i = data().players.indexOf(name);
  return i >= 0 && i < 8 ? `var(--p${i + 1})` : 'var(--muted)';
}

function teamName(t) {
  return t.map(esc).join(' & ');
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : /(ch|s)$/.test(word) ? 'es' : 's'}`;
}

function sortedMatches(ms) {
  return [...ms].sort((x, y) => x.date.localeCompare(y.date) || x.t - y.t);
}

function sessionDates(ms) {
  return [...new Set(ms.map(m => m.date))].sort();
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- Stats engine ---------- */

/**
 * Elo-style rating for doubles: each team's strength is the average of its
 * players' ratings; every player on a team gains/loses the same amount.
 * A bigger game margin gives a slightly bigger swing.
 */
function computeRatings(matches, players) {
  const rating = Object.fromEntries(players.map(p => [p, START_RATING]));
  const byMatch = new Map();
  const bySession = []; // [{date, ratings}]
  let lastDate = null;

  for (const m of sortedMatches(matches)) {
    if (lastDate && m.date !== lastDate) bySession.push({ date: lastDate, ratings: { ...rating } });
    lastDate = m.date;

    const ra = (rating[m.a[0]] + rating[m.a[1]]) / 2;
    const rb = (rating[m.b[0]] + rating[m.b[1]]) / 2;
    const expectedA = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    const resultA = m.sa > m.sb ? 1 : m.sa < m.sb ? 0 : 0.5;
    const margin = Math.abs(m.sa - m.sb);
    const mult = margin ? 1 + Math.log(margin) / 4 : 1;
    const delta = K_FACTOR * mult * (resultA - expectedA);

    const deltas = {};
    for (const p of m.a) { rating[p] += delta; deltas[p] = delta; }
    for (const p of m.b) { rating[p] -= delta; deltas[p] = -delta; }
    byMatch.set(m.id, deltas);
  }
  if (lastDate) bySession.push({ date: lastDate, ratings: { ...rating } });

  return { rating, byMatch, bySession };
}

function newPlayerStat() {
  return { played: 0, wins: 0, losses: 0, draws: 0, gf: 0, ga: 0, results: [], streak: 0, bestStreak: 0 };
}

function computeStats(matches, players) {
  const ps = Object.fromEntries(players.map(p => [p, newPlayerStat()]));
  const pairs = new Map();  // "A|B" -> {players, played, wins, gf, ga}
  const versus = new Map(); // "A>B" -> {played, wins} from A's perspective

  const pairKey = t => [...t].sort().join('|');

  for (const m of sortedMatches(matches)) {
    const sides = [[m.a, m.sa, m.sb, m.b], [m.b, m.sb, m.sa, m.a]];
    for (const [team, f, a, opp] of sides) {
      const res = f > a ? 'w' : f < a ? 'l' : 'd';

      for (const p of team) {
        const s = ps[p] || (ps[p] = newPlayerStat());
        s.played++;
        s.gf += f;
        s.ga += a;
        s.results.push(res);
        if (res === 'w') { s.wins++; s.streak = s.streak > 0 ? s.streak + 1 : 1; }
        else if (res === 'l') { s.losses++; s.streak = s.streak < 0 ? s.streak - 1 : -1; }
        else { s.draws++; s.streak = 0; }
        s.bestStreak = Math.max(s.bestStreak, s.streak);

        for (const o of opp) {
          const k = `${p}>${o}`;
          const v = versus.get(k) || { played: 0, wins: 0 };
          v.played++;
          if (res === 'w') v.wins++;
          versus.set(k, v);
        }
      }

      const k = pairKey(team);
      const pr = pairs.get(k) || { players: [...team].sort(), played: 0, wins: 0, gf: 0, ga: 0 };
      pr.played++;
      if (res === 'w') pr.wins++;
      pr.gf += f;
      pr.ga += a;
      pairs.set(k, pr);
    }
  }
  return { ps, pairs, versus };
}

function filterByPeriod(matches, p) {
  if (p === 'all' || !matches.length) return matches;
  if (p === 'session') {
    const last = sessionDates(matches).at(-1);
    return matches.filter(m => m.date === last);
  }
  // month: the calendar month of the latest game
  const last = sessionDates(matches).at(-1).slice(0, 7);
  return matches.filter(m => m.date.startsWith(last));
}

/* ---------- Rendering: shell ---------- */

function render() {
  const { view } = route;
  document.querySelectorAll('.tabbar button').forEach(b => {
    const v = b.dataset.nav;
    b.classList.toggle('active', v === view || (view === 'player' && v === 'dashboard'));
  });
  $('.tab-add').hidden = readOnly();

  renderBanner();
  chartModels = {};
  const views = { dashboard: viewDashboard, history: viewHistory, add: viewAdd, insights: viewInsights, more: viewMore, player: viewPlayer };
  $('#app').innerHTML = (views[view] || viewDashboard)();
  $('#title').textContent = {
    dashboard: 'Leaderboard', history: 'Matches', add: draft?.id ? 'Edit match' : 'Add match',
    insights: 'Insights', more: 'More', player: 'Player',
  }[view] || 'Padel Tracker';
  hideTooltip();
  mountCharts();
}

function renderBanner() {
  const el = $('#banner');
  if (!snapshot) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="banner">
      <b>Viewing a shared snapshot</b> · ${plural(snapshot.matches.length, "match")}.
      ${db.matches.length ? '' : 'Save it to this phone to start adding matches.'}
      <div class="btn-row">
        <button class="btn primary" data-action="import-snapshot">Save to this phone</button>
        <button class="btn" data-action="close-snapshot">Close</button>
      </div>
    </div>`;
}

function go(view, extra = {}) {
  route = { view, ...extra };
  if (view === 'add' && !extra.keepDraft) draft = newDraft();
  render();
  window.scrollTo(0, 0);
}

// Re-render in place (keeps the scroll position), e.g. while filling in the form.
const refresh = () => render();

/* ---------- View: dashboard ---------- */

function viewDashboard() {
  const { players, matches } = data();
  if (!matches.length) {
    return `
      <div class="empty">
        <div class="big">🎾</div>
        <h2>No matches yet</h2>
        <p>Add your first result after the next match on Saturday.</p>
        ${readOnly() ? '' : '<button class="btn primary" data-nav="add">Add a match</button>'}
      </div>`;
  }

  const scoped = filterByPeriod(matches, period);
  const { ps } = computeStats(scoped, players);
  const { rating, bySession } = computeRatings(matches, players);
  const prev = bySession.length > 1 ? bySession.at(-2).ratings : null;
  const lastDate = sessionDates(matches).at(-1);

  // Sort: by rating for all time; by wins / win% for shorter periods.
  const rows = players
    .filter(p => period === 'all' || ps[p].played > 0)
    .map(p => ({ p, s: ps[p], r: rating[p] }));
  if (period === 'all') rows.sort((x, y) => y.r - x.r);
  else rows.sort((x, y) => y.s.wins - x.s.wins || pct(y.s.wins, y.s.played) - pct(x.s.wins, x.s.played) || (y.s.gf - y.s.ga) - (x.s.gf - x.s.ga));

  const sessions = sessionDates(scoped).length;
  const gamesPlayed = scoped.reduce((n, m) => n + m.sa + m.sb, 0);

  const lastSession = matches.filter(m => m.date === lastDate);
  const day = computeStats(lastSession, players).ps;
  const star = players
    .filter(p => day[p].played)
    .sort((x, y) => day[y].wins - day[x].wins || (day[y].gf - day[y].ga) - (day[x].gf - day[x].ga))[0];

  const periodLabel = { all: 'All time', month: fmtDate(lastDate, { month: 'long' }), session: 'Last session' };

  return `
    <div class="card hero">
      <div class="trophy" aria-hidden="true">🏆</div>
      <div>
        <div class="small muted">Star of ${fmtDate(lastDate)}</div>
        <div class="name">${esc(star)}</div>
        <div class="small">${day[star].wins}W – ${day[star].losses}L · ${signed(day[star].gf - day[star].ga)} games</div>
      </div>
    </div>

    <div class="segmented" role="tablist">
      ${['all', 'month', 'session'].map(k => `<button data-period="${k}" class="${period === k ? 'on' : ''}">${esc(periodLabel[k])}</button>`).join('')}
    </div>

    <div class="tiles">
      <div class="tile"><div class="label">Matches</div><div class="value">${scoped.length}</div></div>
      <div class="tile"><div class="label">Saturdays</div><div class="value">${sessions}</div></div>
      <div class="tile"><div class="label">Games</div><div class="value">${gamesPlayed}</div><div class="note">e.g. 6–4 = 10</div></div>
    </div>

    <div class="card">
      <table class="board">
        <thead><tr>
          <th></th><th>Player</th>
          ${period === 'all' ? '<th>Rating</th>' : ''}
          <th>W–L</th><th>Win%</th>
        </tr></thead>
        <tbody>
          ${rows.map(({ p, s, r }, i) => {
            const d = prev ? r - prev[p] : 0;
            return `
            <tr data-player="${esc(p)}">
              <td class="rank">${i + 1}</td>
              <td class="who"><span class="dot" style="--c:${colorOf(p)}"></span>${esc(p)}<div class="who-form">${formDots(s.results)}</div></td>
              ${period === 'all' ? `<td><b>${Math.round(r)}</b>${prev && Math.round(d) ? `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(Math.round(d))}</span>` : ''}</td>` : ''}
              <td>${s.wins}–${s.losses}</td>
              <td>${s.played ? pct(s.wins, s.played) + '%' : '–'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <p class="hint">Tap a player for their details. ${period === 'all' ? 'Rating starts at 1000; ▲▼ is the change from the last Saturday.' : ''}</p>
    </div>

    <h3 class="section-title">Rating over time</h3>
    <div class="card">
      ${ratingChartHtml(bySession, players)}
    </div>`;
}

function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}

function formDots(results, n = 5) {
  const last = results.slice(-n);
  if (!last.length) return '<span class="muted">–</span>';
  return `<span class="form" aria-label="Last ${last.length} results">${last.map(r => `<i class="${r}">${r.toUpperCase()}</i>`).join('')}</span>`;
}

/* ---------- View: history ---------- */

function viewHistory() {
  const { matches } = data();
  if (!matches.length) return `<div class="empty"><div class="big">📋</div><p>No matches recorded yet.</p></div>`;

  const { byMatch } = computeRatings(matches, data().players);
  const dates = sessionDates(matches).reverse();

  return dates.map(date => {
    const day = sortedMatches(matches.filter(m => m.date === date));
    return `
      <div class="day-head">
        <h3>${fmtDate(date, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })}</h3>
        <button data-action="share-day" data-date="${date}">Share</button>
      </div>
      ${day.map((m, i) => matchCard(m, i + 1, byMatch.get(m.id))).join('')}`;
  }).join('');
}

function matchCard(m, n, deltas, prefix = '') {
  const aWon = m.sa > m.sb, bWon = m.sb > m.sa;
  const swing = deltas ? Math.round(Math.abs(deltas[m.a[0]])) : 0;
  return `
    <button class="match" data-action="${readOnly() ? '' : 'edit'}" data-id="${m.id}">
      <div class="team ${aWon ? 'won' : ''}">${teamName(m.a)}</div>
      <div class="score">${m.sa} – ${m.sb}</div>
      <div class="team right ${bWon ? 'won' : ''}">${teamName(m.b)}</div>
      <div class="num">${prefix}Match ${n}${swing ? ` · ±${swing} rating` : ''}${readOnly() ? '' : ' · tap to edit'}</div>
    </button>`;
}

/* ---------- View: add / edit game ---------- */

function newDraft(m) {
  if (m) return { id: m.id, date: m.date, t: m.t, a: [...m.a], b: [...m.b], sa: m.sa, sb: m.sb };
  const last = db.matches.length ? sortedMatches(db.matches).at(-1) : null;
  // Same day as the last game? keep date. Otherwise today.
  return { id: null, date: todayStr(), a: [], b: [], sa: 6, sb: 4, lastDate: last?.date };
}

function viewAdd() {
  if (readOnly()) return `<div class="empty"><p>Close the shared snapshot to add matches.</p></div>`;
  const d = draft || (draft = newDraft());
  const players = db.players;

  const teamBox = (side, label, color) => `
    <div class="card team-box" style="--tc:${color}">
      <h2>${label}</h2>
      <p class="sub">${d[side].length === 2 ? teamName(d[side]) : `Pick ${2 - d[side].length} more`}</p>
      <div class="chips">
        ${players.map(p => {
          const on = d[side].includes(p);
          const taken = d[side === 'a' ? 'b' : 'a'].includes(p);
          const full = d[side].length >= 2 && !on;
          return `<button class="chip ${on ? 'on' : ''}" data-pick="${side}" data-name="${esc(p)}" ${taken || full ? 'disabled' : ''} aria-pressed="${on}">${esc(p)}</button>`;
        }).join('')}
      </div>
    </div>`;

  const ready = d.a.length === 2 && d.b.length === 2 && d.sa !== d.sb && d.date;
  const why = d.a.length < 2 || d.b.length < 2 ? 'Pick two players for each team.' : d.sa === d.sb ? 'Scores can’t be level — someone has to win.' : '';

  const stepper = (side, label, color) => `
    <div class="stepper" style="--tc:${color}">
      <div class="lbl">${label}</div>
      <div class="ctrl">
        <button data-step="${side}" data-by="-1" aria-label="${label} minus">−</button>
        <output>${d[side === 'a' ? 'sa' : 'sb']}</output>
        <button data-step="${side}" data-by="1" aria-label="${label} plus">+</button>
      </div>
    </div>`;

  return `
    ${teamBox('a', 'Team A', 'var(--team-a)')}
    ${teamBox('b', 'Team B', 'var(--team-b)')}

    <div class="card">
      <h2>Score</h2>
      <p class="sub">Games won by each team, e.g. 6 – 4</p>
      <div class="score-row">
        ${stepper('a', 'Team A', 'var(--team-a)')}
        <div class="vs">vs</div>
        ${stepper('b', 'Team B', 'var(--team-b)')}
      </div>
    </div>

    <div class="card field">
      <label for="date">Date</label>
      <input id="date" type="date" value="${d.date}" max="${todayStr()}">
    </div>

    <button class="btn primary block" data-action="save" ${ready ? '' : 'disabled'}>${d.id ? 'Save changes' : 'Save match'}</button>
    ${why ? `<p class="hint">${why}</p>` : ''}
    ${d.id ? `
      <div class="btn-row" style="margin-top:12px">
        <button class="btn" data-nav="history">Cancel</button>
        <button class="btn danger" data-action="delete" data-id="${d.id}">Delete match</button>
      </div>` : ''}`;
}

function saveDraft() {
  const d = draft;
  if (!(d.a.length === 2 && d.b.length === 2 && d.sa !== d.sb)) return;
  if (d.id) {
    const m = db.matches.find(x => x.id === d.id);
    Object.assign(m, { date: d.date, a: d.a, b: d.b, sa: d.sa, sb: d.sb });
    saveDb();
    toast('Match updated');
    go('history');
    return;
  }
  const m = { id: uid(), date: d.date, t: Date.now(), a: d.a, b: d.b, sa: d.sa, sb: d.sb };
  db.matches.push(m);
  saveDb();
  const n = db.matches.filter(x => x.date === m.date).length;
  toast(`Match ${n} of the day saved ✓`);
  // Keep the date and scores handy for the next game of the day.
  draft = { id: null, date: d.date, a: [], b: [], sa: 6, sb: 4 };
  route = { view: 'add' };
  render();
  window.scrollTo(0, 0);
}

/* ---------- View: insights ---------- */

function viewInsights() {
  const { players, matches } = data();
  if (!matches.length) return `<div class="empty"><div class="big">💡</div><p>Insights appear once a few matches are in.</p></div>`;

  const { ps, pairs, versus } = computeStats(matches, players);
  const pairList = [...pairs.values()];
  const qualified = pairList.filter(p => p.played >= MIN_PAIR_GAMES);
  const pool = qualified.length ? qualified : pairList;

  const best = [...pool].sort((x, y) => pct(y.wins, y.played) - pct(x.wins, x.played) || y.played - x.played)[0];
  const worst = [...pool].sort((x, y) => pct(x.wins, x.played) - pct(y.wins, y.played) || y.played - x.played)[0];
  const mostPlayed = [...pairList].sort((x, y) => y.played - x.played)[0];

  // Rivalry: two players who faced each other most often.
  let rival = null;
  for (const [k, v] of versus) {
    const [p, o] = k.split('>');
    if (p > o) continue;
    if (!rival || v.played > rival.played) rival = { p, o, ...v };
  }

  const active = players.filter(p => ps[p].played);
  const hot = [...active].sort((x, y) => ps[y].streak - ps[x].streak)[0];
  const bestStreak = [...active].sort((x, y) => ps[y].bestStreak - ps[x].bestStreak)[0];
  const ironman = [...active].sort((x, y) => ps[y].played - ps[x].played)[0];
  const sharp = [...active].sort((x, y) => (ps[y].gf - ps[y].ga) / ps[y].played - (ps[x].gf - ps[x].ga) / ps[x].played)[0];
  const blowout = [...matches].sort((x, y) => Math.abs(y.sa - y.sb) - Math.abs(x.sa - x.sb) || y.date.localeCompare(x.date))[0];
  const tight = matches.filter(m => Math.abs(m.sa - m.sb) === 1).length;

  const card = (ico, k, v, d) => `
    <div class="card insight">
      <div class="ico" aria-hidden="true">${ico}</div>
      <div><div class="k">${k}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>
    </div>`;

  const pairLine = pr => `${pr.wins}–${pr.played - pr.wins} together · ${pct(pr.wins, pr.played)}%`;

  const winningBlowout = blowout.sa > blowout.sb ? blowout.a : blowout.b;

  return `
    ${card('🤝', 'Dream team', teamName(best.players), pairLine(best) + (qualified.length ? '' : ' · few games so far'))}
    ${pool.length > 1 ? card('🧊', 'Still finding their rhythm', teamName(worst.players), pairLine(worst)) : ''}
    ${card('🔁', 'Most frequent pair', teamName(mostPlayed.players), `${plural(mostPlayed.played, "match")} together`)}
    ${rival ? card('⚔️', 'Biggest rivalry', `${esc(rival.p)} vs ${esc(rival.o)}`, `Faced ${plural(rival.played, 'time')} · ${rivalryLine(rival, versus)}`) : ''}

    <div class="grid2">
      ${card('🔥', 'On fire', esc(hot), ps[hot].streak > 0 ? `${ps[hot].streak} wins in a row` : 'No one is on a streak')}
      ${card('📈', 'Best streak', esc(bestStreak), `${ps[bestStreak].bestStreak} straight wins`)}
      ${card('🎯', 'Best game diff', esc(sharp), `${signed(+((ps[sharp].gf - ps[sharp].ga) / ps[sharp].played).toFixed(1))} per match`)}
      ${card('🏃', 'Iron man', esc(ironman), plural(ps[ironman].played, "match"))}
    </div>
    <div style="height:14px"></div>
    ${card('💥', 'Biggest win', `${teamName(winningBlowout)} · ${Math.max(blowout.sa, blowout.sb)}–${Math.min(blowout.sa, blowout.sb)}`, fmtDate(blowout.date))}
    ${card('😬', 'Nail-biters', plural(tight, "match"), 'decided by a single game')}

    <h3 class="section-title">Partnership win %</h3>
    <div class="card">
      <p class="sub">Win rate when two players are on the same team. Small number = matches together.</p>
      ${partnershipHeatmap(players.filter(p => ps[p].played), pairs)}
    </div>

    <h3 class="section-title">All partnerships</h3>
    <div class="card">
      <ul class="list">
        ${[...pairList].sort((x, y) => pct(y.wins, y.played) - pct(x.wins, x.played) || y.played - x.played).map(pr => `
          <li><span>${teamName(pr.players)}</span><span class="r">${pr.wins}–${pr.played - pr.wins} · ${pct(pr.wins, pr.played)}%</span></li>`).join('')}
      </ul>
    </div>`;
}

function rivalryLine({ p, o, wins }, versus) {
  const theirs = versus.get(`${o}>${p}`).wins;
  if (wins === theirs) return `level ${wins}–${theirs}`;
  return wins > theirs ? `${esc(p)} leads ${wins}–${theirs}` : `${esc(o)} leads ${theirs}–${wins}`;
}

const HEAT_STEPS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6'];

function partnershipHeatmap(players, pairs) {
  if (players.length < 2) return '<p class="muted">Not enough data yet.</p>';
  const cell = (a, b) => {
    if (a === b) return '<td class="self"></td>';
    const pr = pairs.get([a, b].sort().join('|'));
    if (!pr) return '<td class="muted" title="Never paired">–</td>';
    const w = pct(pr.wins, pr.played);
    const step = Math.min(HEAT_STEPS.length - 1, Math.floor(w / (100 / HEAT_STEPS.length)));
    const fg = step >= 3 ? '#fff' : '#0b0b0b';
    return `<td style="background:var(${HEAT_STEPS[step]});color:${fg}" title="${esc(a)} & ${esc(b)}: ${pr.wins}/${pr.played}">${w}<small>${pr.played}</small></td>`;
  };
  return `
    <div class="heat-wrap">
      <table class="heat">
        <tr><th></th>${players.map(p => `<th class="colh">${esc(p)}</th>`).join('')}</tr>
        ${players.map(a => `<tr><th class="rowh">${esc(a)}</th>${players.map(b => cell(a, b)).join('')}</tr>`).join('')}
      </table>
    </div>
    <div class="legend-scale">0%${HEAT_STEPS.map(s => `<span class="sw" style="background:var(${s})"></span>`).join('')}100%</div>`;
}

/* ---------- View: player ---------- */

function viewPlayer() {
  const { players, matches } = data();
  const name = route.name;
  const { ps, pairs, versus } = computeStats(matches, players);
  const s = ps[name] || newPlayerStat();
  const { rating, bySession, byMatch } = computeRatings(matches, players);

  const partners = [...pairs.values()]
    .filter(pr => pr.players.includes(name))
    .map(pr => ({ who: pr.players.find(x => x !== name), ...pr }))
    .sort((x, y) => pct(y.wins, y.played) - pct(x.wins, x.played) || y.played - x.played);

  const opponents = players
    .filter(o => o !== name && versus.get(`${name}>${o}`))
    .map(o => ({ who: o, ...versus.get(`${name}>${o}`) }))
    .sort((x, y) => pct(x.wins, x.played) - pct(y.wins, y.played) || y.played - x.played);

  const peak = Math.max(START_RATING, ...bySession.map(b => b.ratings[name]));
  const recent = sortedMatches(matches.filter(m => m.a.includes(name) || m.b.includes(name))).reverse().slice(0, 8);

  const rank = [...players].sort((x, y) => rating[y] - rating[x]).indexOf(name) + 1;

  return `
    <button class="back" data-nav="dashboard">‹ Leaderboard</button>
    <div class="player-head">
      <div class="avatar" style="--c:${colorOf(name)}">${esc(name[0])}</div>
      <div>
        <h2>${esc(name)}</h2>
        <div class="small muted">#${rank} · rating ${Math.round(rating[name])} · peak ${Math.round(peak)}</div>
      </div>
    </div>

    <div class="tiles">
      <div class="tile"><div class="label">Record</div><div class="value">${s.wins}–${s.losses}</div><div class="note">${plural(s.played, "match")}</div></div>
      <div class="tile"><div class="label">Win rate</div><div class="value">${pct(s.wins, s.played)}%</div><div class="note">${formDots(s.results, 4)}</div></div>
      <div class="tile"><div class="label">Game diff</div><div class="value">${signed(s.gf - s.ga)}</div><div class="note">${s.gf} won · ${s.ga} lost</div></div>
    </div>

    <div class="grid2">
      <div class="card insight"><div class="ico" aria-hidden="true">🤝</div><div><div class="k">Best partner</div><div class="v">${partners[0] ? esc(partners[0].who) : '–'}</div>${partners[0] ? `<div class="d">${partners[0].wins}–${partners[0].played - partners[0].wins} together</div>` : ''}</div></div>
      <div class="card insight"><div class="ico" aria-hidden="true">😤</div><div><div class="k">Toughest opponent</div><div class="v">${opponents[0] ? esc(opponents[0].who) : '–'}</div>${opponents[0] ? `<div class="d">${opponents[0].wins}–${opponents[0].played - opponents[0].wins} against</div>` : ''}</div></div>
    </div>
    <div style="height:14px"></div>

    <div class="card">
      <h2>Rating</h2>
      ${ratingChartHtml(bySession, [name])}
    </div>

    <div class="card">
      <h2>With partner</h2>
      <ul class="list">
        ${partners.map(p => `<li><span><span class="dot" style="--c:${colorOf(p.who)}"></span>${esc(p.who)}</span><span class="r">${p.wins}–${p.played - p.wins} · ${pct(p.wins, p.played)}%</span></li>`).join('') || '<li class="muted">No matches yet</li>'}
      </ul>
    </div>

    <div class="card">
      <h2>Against</h2>
      <ul class="list">
        ${opponents.map(o => `<li><span><span class="dot" style="--c:${colorOf(o.who)}"></span>${esc(o.who)}</span><span class="r">${o.wins}–${o.played - o.wins} · ${pct(o.wins, o.played)}%</span></li>`).join('') || '<li class="muted">No matches yet</li>'}
      </ul>
    </div>

    <h3 class="section-title">Recent matches</h3>
    ${recent.map(m => {
      const d = byMatch.get(m.id)[name];
      const n = sortedMatches(matches.filter(x => x.date === m.date)).indexOf(m) + 1;
      return matchCard(m, n, null, `${fmtShort(m.date)} · <span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${Math.round(d)}</span> · `);
    }).join('') || '<p class="muted">No matches yet.</p>'}`;
}

/* ---------- View: more (share, backup, players) ---------- */

function viewMore() {
  return `
    <div class="card">
      <h2>Share with the group</h2>
      <p class="sub">Send a link so everyone can see the leaderboard on their own phone. The link is a snapshot — share a fresh one after each Saturday.</p>
      <div class="btn-row">
        <button class="btn primary" data-action="share-link">Share leaderboard link</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" data-action="share-day" data-date="${sessionDates(data().matches).at(-1) || ''}" ${data().matches.length ? '' : 'disabled'}>Share last Saturday’s results</button>
      </div>
    </div>

    ${readOnly() ? '' : `
    <div class="card">
      <h2>Players</h2>
      <p class="sub">Rename someone or add a guest player.</p>
      ${db.players.map((p, i) => `
        <div class="setting-row field">
          <input value="${esc(p)}" data-rename="${i}" aria-label="Player ${i + 1} name" maxlength="20">
        </div>`).join('')}
      <div class="setting-row field">
        <input id="new-player" placeholder="New player name" maxlength="20">
        <button class="btn" data-action="add-player">Add</button>
      </div>
    </div>

    <div class="card">
      <h2>Backup</h2>
      <p class="sub">Data is stored on this phone only. Export a backup now and then, or to move to another phone.</p>
      <div class="btn-row">
        <button class="btn" data-action="export">Export</button>
        <button class="btn" data-action="import">Import</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </div>

    <div class="card">
      <h2>Danger zone</h2>
      <button class="btn danger block" data-action="reset">Delete all matches</button>
    </div>`}

    <p class="hint">Padel Tracker · ${plural(data().matches.length, "match")} recorded</p>`;
}

/* ---------- Charts ---------- */

function ratingChartHtml(bySession, names) {
  if (!bySession.length) return '<p class="muted">The chart appears after the first Saturday.</p>';
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  chartModels[id] = { bySession, names };
  const legend = names.length > 1 ? `
    <div class="legend">
      ${names.map(n => `<button data-series="${esc(n)}" class="${hiddenSeries.has(n) ? 'off' : ''}"><span class="sw" style="--c:${colorOf(n)}"></span>${esc(n)}</button>`).join('')}
    </div>` : '';
  return `<div class="chart" data-chart="${id}"></div>${legend}`;
}

let chartModels = {};

function mountCharts() {
  document.querySelectorAll('[data-chart]').forEach(el => drawChart(el, chartModels[el.dataset.chart]));
}

function drawChart(el, model) {
  if (!model) return;
  const { bySession, names } = model;
  // Points: a "Start" baseline then one point per Saturday.
  const xs = [{ label: 'Start', ratings: Object.fromEntries(names.map(n => [n, START_RATING])) },
    ...bySession.map(b => ({ label: fmtShort(b.date), date: b.date, ratings: b.ratings }))];
  const visible = names.filter(n => !hiddenSeries.has(n) || names.length === 1);

  const W = Math.max(280, el.clientWidth), H = 200;
  const pad = { l: 38, r: 10, t: 10, b: 24 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

  const vals = xs.flatMap(x => visible.map(n => x.ratings[n] ?? START_RATING));
  let lo = Math.min(...vals, START_RATING), hi = Math.max(...vals, START_RATING);
  const span = Math.max(40, hi - lo);
  const stepSize = niceStep(span / 4);
  lo = Math.floor((lo - 5) / stepSize) * stepSize;
  hi = Math.ceil((hi + 5) / stepSize) * stepSize;

  const x = i => pad.l + (xs.length === 1 ? iw / 2 : (i / (xs.length - 1)) * iw);
  const y = v => pad.t + ih - ((v - lo) / (hi - lo)) * ih;

  let g = '';
  for (let v = lo; v <= hi + 0.001; v += stepSize) {
    g += `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    g += `<text class="axis-label" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  // X labels: first, last, and a few in between that fit.
  const maxLabels = Math.max(2, Math.floor(iw / 60));
  const every = Math.ceil(xs.length / maxLabels);
  xs.forEach((p, i) => {
    if (i === xs.length - 1 || (i % every === 0 && xs.length - 1 - i >= every)) {
      const anchor = i === 0 ? 'start' : i === xs.length - 1 ? 'end' : 'middle';
      g += `<text class="axis-label" x="${x(i)}" y="${H - 6}" text-anchor="${anchor}">${esc(p.label)}</text>`;
    }
  });

  const showMarkers = xs.length <= 12;
  const lines = visible.map(n => {
    const pts = xs.map((p, i) => `${x(i).toFixed(1)},${y(p.ratings[n] ?? START_RATING).toFixed(1)}`);
    const markers = showMarkers || names.length === 1
      ? xs.map((p, i) => `<circle class="marker" cx="${x(i)}" cy="${y(p.ratings[n] ?? START_RATING)}" r="4" fill="${colorOf(n)}"/>`).join('')
      : '';
    return `<g data-line="${esc(n)}"><polyline class="line" stroke="${colorOf(n)}" points="${pts.join(' ')}"/>${markers}</g>`;
  }).join('');

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Rating over time for ${esc(names.join(', '))}">
      ${g}
      <line class="crosshair" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>
      ${lines}
      <rect x="${pad.l - 10}" y="0" width="${iw + 20}" height="${H}" fill="transparent"/>
    </svg>`;

  const svg = el.querySelector('svg');
  const cross = el.querySelector('.crosshair');
  const onMove = ev => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = xs.length === 1 ? 0 : Math.max(0, Math.min(xs.length - 1, Math.round(((px - pad.l) / iw) * (xs.length - 1))));
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    const p = xs[i], prev = xs[i - 1];
    const rows = visible
      .map(n => ({ n, v: p.ratings[n] ?? START_RATING, d: prev ? (p.ratings[n] ?? START_RATING) - (prev.ratings[n] ?? START_RATING) : 0 }))
      .sort((a, b) => b.v - a.v);
    showTooltip(ev.clientX, r.top + y(rows[0].v) * (r.height / H), `
      <div class="t">${p.date ? fmtDate(p.date) : 'Start'}</div>
      ${rows.map(rw => `<div class="row"><span><span class="dot" style="--c:${colorOf(rw.n)}"></span>${esc(rw.n)}</span><b>${Math.round(rw.v)}${rw.d ? ` <span class="${rw.d > 0 ? 'up' : 'down'}">${rw.d > 0 ? '+' : ''}${Math.round(rw.d)}</span>` : ''}</b></div>`).join('')}`);
  };
  const onLeave = () => { cross.setAttribute('visibility', 'hidden'); hideTooltip(); };
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerdown', onMove);
  svg.addEventListener('pointerleave', onLeave);
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function showTooltip(cx, cy, html) {
  const tip = $('#tooltip');
  tip.innerHTML = html;
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = cx + 14;
  if (left + w > window.innerWidth - 8) left = cx - w - 14;
  left = Math.max(8, left);
  const top = Math.max(8, Math.min(window.innerHeight - h - 90, cy - h / 2));
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function hideTooltip() {
  const tip = $('#tooltip');
  if (tip) tip.hidden = true;
}

/* ---------- Sharing ---------- */

function daySummary(date) {
  const { players, matches } = data();
  const day = sortedMatches(matches.filter(m => m.date === date));
  const { ps } = computeStats(day, players);
  const lines = [`🎾 Padel — ${fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}`, ''];
  day.forEach((m, i) => {
    const win = m.sa > m.sb;
    lines.push(`${i + 1}. ${win ? '🏆 ' : ''}${m.a.join(' & ')}  ${m.sa}–${m.sb}  ${m.b.join(' & ')}${win ? '' : ' 🏆'}`);
  });
  lines.push('', 'Today:');
  players
    .filter(p => ps[p].played)
    .sort((x, y) => ps[y].wins - ps[x].wins || (ps[y].gf - ps[y].ga) - (ps[x].gf - ps[x].ga))
    .forEach((p, i) => lines.push(`${['🥇', '🥈', '🥉'][i] || '▫️'} ${p}: ${ps[p].wins}W ${ps[p].losses}L (${signed(ps[p].gf - ps[p].ga)})`));
  return lines.join('\n');
}

async function shareText(text, url) {
  if (navigator.share) {
    try { await navigator.share(url ? { text, url } : { text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const full = url ? `${text}\n${url}` : text;
  try {
    await navigator.clipboard.writeText(full);
    toast('Copied — paste it in the group chat');
  } catch {
    window.open(`https://wa.me/?text=${encodeURIComponent(full)}`, '_blank');
  }
}

// Compact encoding for share links: players are stored once, matches as index tuples.
async function encodeSnapshot(d) {
  const idx = Object.fromEntries(d.players.map((p, i) => [p, i]));
  const compact = { v: 1, p: d.players, m: sortedMatches(d.matches).map(m => [m.date, ...m.a.map(n => idx[n]), ...m.b.map(n => idx[n]), m.sa, m.sb]) };
  let bytes = new TextEncoder().encode(JSON.stringify(compact));
  let prefix = 'j';
  if (window.CompressionStream) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    prefix = 'z';
  }
  return prefix + toBase64Url(bytes);
}

async function decodeSnapshot(s) {
  let bytes = fromBase64Url(s.slice(1));
  if (s[0] === 'z') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const c = JSON.parse(new TextDecoder().decode(bytes));
  return normalizeDb({
    players: c.p,
    matches: c.m.map(([date, a1, a2, b1, b2, sa, sb], i) => ({ id: `s${i}`, date, t: i, a: [c.p[a1], c.p[a2]], b: [c.p[b1], c.p[b2]], sa, sb })),
  });
}

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function shareLink() {
  const code = await encodeSnapshot(data());
  const url = `${location.origin}${location.pathname}#d=${code}`;
  await shareText('🎾 Padel leaderboard — tap to see the latest standings', url);
}

async function readHash() {
  const m = location.hash.match(/^#d=(.+)$/);
  if (!m) return;
  try {
    snapshot = await decodeSnapshot(m[1]);
  } catch {
    toast('That link looks broken');
    history.replaceState(null, '', location.pathname);
  }
}

function closeSnapshot() {
  snapshot = null;
  history.replaceState(null, '', location.pathname);
  render();
}

function importSnapshot() {
  if (db.matches.length && !confirm(`Replace the ${plural(db.matches.length, "match")} on this phone with the shared snapshot?`)) return;
  db = { players: [...snapshot.players], matches: snapshot.matches.map(m => ({ ...m, id: uid() + m.id })) };
  saveDb();
  toast('Saved to this phone');
  closeSnapshot();
}

/* ---------- Backup ---------- */

function exportJson() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `padel-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const next = normalizeDb(JSON.parse(reader.result));
      if (!confirm(`Replace all data with ${plural(next.matches.length, "match")} from the backup?`)) return;
      db = next;
      saveDb();
      toast('Backup restored');
      go('dashboard');
    } catch {
      toast('That file isn’t a Padel Tracker backup');
    }
  };
  reader.readAsText(file);
}

/* ---------- Events ---------- */

document.addEventListener('click', e => {
  const t = e.target.closest('button, tr[data-player]');
  if (!t) return;

  if (t.dataset.nav) return go(t.dataset.nav);
  if (t.dataset.player) return go('player', { name: t.dataset.player });
  if (t.dataset.period) { period = t.dataset.period; return render(); }

  if (t.dataset.series) {
    const n = t.dataset.series;
    hiddenSeries.has(n) ? hiddenSeries.delete(n) : hiddenSeries.add(n);
    // Never hide every line.
    if (data().players.every(p => hiddenSeries.has(p))) hiddenSeries.clear();
    return render();
  }

  if (t.dataset.pick) {
    const side = t.dataset.pick, name = t.dataset.name, team = draft[side];
    const i = team.indexOf(name);
    if (i >= 0) team.splice(i, 1);
    else if (team.length < 2) team.push(name);
    return refresh();
  }

  if (t.dataset.step) {
    const key = t.dataset.step === 'a' ? 'sa' : 'sb';
    draft[key] = Math.max(0, Math.min(99, draft[key] + Number(t.dataset.by)));
    return refresh();
  }

  switch (t.dataset.action) {
    case 'save': return saveDraft();
    case 'edit': {
      const m = db.matches.find(x => x.id === t.dataset.id);
      if (!m) return;
      draft = newDraft(m);
      return go('add', { keepDraft: true });
    }
    case 'delete':
      if (confirm('Delete this match?')) {
        db.matches = db.matches.filter(m => m.id !== t.dataset.id);
        saveDb();
        toast('Match deleted');
        go('history');
      }
      return;
    case 'share-day': return t.dataset.date && shareText(daySummary(t.dataset.date));
    case 'share-link': return shareLink();
    case 'import-snapshot': return importSnapshot();
    case 'close-snapshot': return closeSnapshot();
    case 'export': return exportJson();
    case 'import': return $('#import-file').click();
    case 'add-player': {
      const input = $('#new-player');
      const name = input.value.trim();
      if (!name) return;
      if (db.players.some(p => p.toLowerCase() === name.toLowerCase())) return toast('That name already exists');
      db.players.push(name);
      saveDb();
      toast(`${name} added`);
      return render();
    }
    case 'reset':
      if (confirm('Delete ALL matches? Export a backup first if unsure.') && confirm('Really delete everything?')) {
        db.matches = [];
        saveDb();
        toast('All matches deleted');
        go('dashboard');
      }
      return;
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'date' && draft) { draft.date = t.value; return; }
  if (t.id === 'import-file' && t.files[0]) { importJson(t.files[0]); t.value = ''; return; }
  if (t.dataset.rename !== undefined) {
    const i = Number(t.dataset.rename);
    const old = db.players[i];
    const name = t.value.trim();
    if (!name || name === old) { t.value = old; return; }
    if (db.players.some((p, j) => j !== i && p.toLowerCase() === name.toLowerCase())) { t.value = old; return toast('That name already exists'); }
    db.players[i] = name;
    for (const m of db.matches) {
      m.a = m.a.map(p => (p === old ? name : p));
      m.b = m.b.map(p => (p === old ? name : p));
    }
    saveDb();
    toast(`Renamed to ${name}`);
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'new-player') document.querySelector('[data-action="add-player"]').click();
});

window.addEventListener('hashchange', async () => { await readHash(); render(); });

let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(mountCharts, 150); });
window.addEventListener('scroll', hideTooltip, { passive: true });

/* ---------- Boot ---------- */

(async function boot() {
  await readHash();
  render();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
