// ---------------------------------------------------------------------------
// All the view code: the combined Gameweeks tab (week navigator + per-week
// pick UI, fixtures and results), the league table, and the two write actions
// (submitPick / setChip) the pick UI triggers. Reads shared state from `store`
// and refreshes via store.reload() after a write, so it never imports the
// controller directly.
// ---------------------------------------------------------------------------
import {
  TEAMS, CHIPS, BONUS_MULTIPLIER, SCORECARD_BONUS,
  GOLDEN_BOOT_BONUS, CHAMPION_BONUS, UNIQUE_THRESHOLD, halfOf,
} from "./config.js";
import { db, doc, setDoc, deleteDoc } from "./firebase.js";
import { store, nowDate } from "./store.js";
import { scorePick, scoreMultipick, multipickOutcomes, fmtCountdown, trailingStreak } from "./scoring.js";

// Live-ticking countdown to the current gameweek's deadline in the status row.
// Flips the whole app to its locked state (revealing picks) the moment it
// expires. The Gameweeks tab shows each week's own status separately.
export function startDeadlineCountdown(deadlineDate, isOpen) {
  const el = document.getElementById("deadline-text");
  if (store.countdownTimer) { clearInterval(store.countdownTimer); store.countdownTimer = null; }
  if (!isOpen) { el.textContent = `Locked since ${deadlineDate.toLocaleString()}`; return; }
  const tick = () => {
    const ms = deadlineDate - new Date();
    if (ms <= 0) {
      clearInterval(store.countdownTimer);
      store.countdownTimer = null;
      el.textContent = "Locking now…";
      store.reload();   // re-render in the locked state
      return;
    }
    el.textContent = `Locks in ${fmtCountdown(ms)}`;
  };
  tick();
  store.countdownTimer = setInterval(tick, 1000);
}

// Small tag shown next to a pick. For Scorecard it also shows the
// predicted scoreline.
const chipTag = (chip, scorecard) => {
  if (!chip || !CHIPS[chip]) return "";
  let label = CHIPS[chip].label;
  if (chip === "scorecard" && scorecard) label += ` ${scorecard.for}–${scorecard.against}`;
  return `<span class="chip-tag chip-${chip}">${label}</span>`;
};

// Format a team's outcomes with their scorelines, e.g. "Win 2–1" or, for a
// double gameweek, "Win 2–1, Loss 0–3". Forfeits and unknown scores show the
// bare result. Empty -> "Pending".
function fmtResult(outcomes, goals, conceded) {
  if (!outcomes || outcomes.length === 0) return "Pending";
  const g = goals || [], c = conceded || [];
  return outcomes.map((o, i) => {
    const cap = o[0].toUpperCase() + o.slice(1);
    return (o !== "forfeit" && g[i] != null && c[i] != null) ? `${cap} ${g[i]}–${c[i]}` : cap;
  }).join(", ");
}

// ---------------------------------------------------------------------------
// Combined "Gameweeks" tab
// ---------------------------------------------------------------------------

const scheduleEntry = gw => store.schedule.find(s => s.gameweek === gw) || null;
const deadlineOf = gw => store.deadlinesByGw[gw] || null;
const isWeekOpen = gw => { const d = deadlineOf(gw); return !!d && nowDate() < d; };
const fixturesOf = gw => { const e = scheduleEntry(gw); return e ? e.fixtures : []; };
const myPickFor = gw => store.myPicks.find(p => p.gameweek === gw) || null;

// The "current" gameweek from the app's point of view: the earliest scheduled
// week whose deadline hasn't passed (per the — possibly simulated — clock).
// Falls back to the last scheduled week, then to config/current. This is what
// makes the Time Machine move which week reads as "current"/"live".
export function currentGameweek() {
  const now = nowDate();
  const upcoming = store.schedule.filter(s => s.deadline && s.deadline > now);
  if (upcoming.length) return upcoming[0].gameweek;   // schedule is sorted ascending
  if (store.schedule.length) return store.schedule[store.schedule.length - 1].gameweek;
  return store.currentConfig ? store.currentConfig.gameweek : null;
}
const isCurrentGw = gw => gw === currentGameweek();

function fmtDeadline(d) {
  return d.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Teams I can't re-use for this week under the no-repeat rule. A team is
// "used" if it appears in any of my OTHER picks in the same half-season
// (past OR a future pre-pick — reserved immediately), unless that week was
// forfeited (the team didn't play, so it's freed up again).
function teamsUsedForWeek(gw) {
  const half = halfOf(gw);
  const used = new Set();
  const teamsOf = p => (p.chip === "multipick" && p.team2 ? [p.team, p.team2] : [p.team]);
  store.myPicks.forEach(p => {
    if (p.gameweek === gw || halfOf(p.gameweek) !== half) return;
    teamsOf(p).forEach(t => {
      if (!(store.results[`${p.gameweek}_${t}`] || []).includes("forfeit")) used.add(t);
    });
  });
  return used;
}

function selectWeek(gw) {
  store.selectedGameweek = gw;
  store.scorecardEditing = false;
  store.multipickEditing = false;
  renderWeek();
}

function renderNavigator(gw) {
  const sel = document.getElementById("week-select");
  const prev = document.getElementById("week-prev");
  const next = document.getElementById("week-next");
  if (!sel) return;
  const weeks = store.schedule.map(s => s.gameweek);
  sel.innerHTML = weeks
    .map(w => `<option value="${w}"${w === gw ? " selected" : ""}>Gameweek ${w}${isCurrentGw(w) ? " · current" : ""}</option>`)
    .join("");
  sel.onchange = () => selectWeek(parseInt(sel.value, 10));
  const idx = weeks.indexOf(gw);
  if (prev) { prev.disabled = idx <= 0; prev.onclick = () => selectWeek(weeks[idx - 1]); }
  if (next) { next.disabled = idx >= weeks.length - 1; next.onclick = () => selectWeek(weeks[idx + 1]); }
}

// The whole Gameweeks tab. Driven by store.selectedGameweek; re-renders
// client-side (no Firestore read) from the datasets cached on `store`.
export function renderWeek() {
  if (!store.currentConfig || !store.schedule.length) return;
  const weeks = store.schedule.map(s => s.gameweek);
  let gw = store.selectedGameweek;
  if (!weeks.includes(gw)) { gw = store.currentConfig.gameweek; store.selectedGameweek = gw; }

  renderNavigator(gw);

  const deadline = deadlineOf(gw);
  const open = isWeekOpen(gw);
  const statusEl = document.getElementById("week-status");
  if (statusEl) {
    if (!deadline) statusEl.textContent = "Deadline not published yet.";
    else if (open) statusEl.textContent = `${isCurrentGw(gw) ? "Live now" : "Upcoming"} · picking open, locks ${fmtDeadline(deadline)}`;
    else statusEl.textContent = `Locked · ${fmtDeadline(deadline)}`;
  }

  const usedTeams = teamsUsedForWeek(gw);
  renderPickPanel(gw, open, usedTeams);
  renderWeekResults(gw, open);
  renderFixtures(gw);
}

// The pick card for the selected week. Open weeks (current or future) get the
// full team grid + chip row; locked weeks show a one-line summary of your own
// pick (the results table below reveals everyone).
function renderPickPanel(gw, open, usedTeams) {
  const grid = document.getElementById("team-grid");
  const statusEl = document.getElementById("pick-status");
  const heading = document.getElementById("pick-heading");
  const intro = document.getElementById("pick-intro");
  const chipRow = document.getElementById("chip-row");
  const msg = document.getElementById("pick-msg");
  const mp = myPickFor(gw);
  grid.innerHTML = "";

  if (!open) {
    heading.textContent = `Gameweek ${gw}`;
    intro.style.display = "none";
    grid.style.display = "none";
    chipRow.style.display = "none";
    if (msg) msg.textContent = "";
    if (mp) {
      const team = mp.chip === "multipick" && mp.team2 ? `${mp.team} + ${mp.team2}` : mp.team;
      statusEl.innerHTML = `Your pick: <strong>${team}</strong>${chipTag(mp.chip, mp.scorecard)}`;
    } else {
      statusEl.textContent = "You didn't pick this week.";
    }
    return;
  }

  heading.textContent = isCurrentGw(gw) ? "Your Pick" : `Pick ahead · Gameweek ${gw}`;
  intro.style.display = "";
  grid.style.display = "";
  chipRow.style.display = "";

  if (mp) {
    statusEl.textContent = `Current pick: ${mp.team} for GW${gw} — change it anytime before the deadline.`;
  } else {
    statusEl.textContent = isCurrentGw(gw)
      ? "Pick a team you think will win — change it anytime before kickoff of the first match."
      : `Pick ahead for GW${gw} — you can change it right up to that week's deadline.`;
  }

  const isMine = (team) => mp && (mp.team === team || (mp.chip === "multipick" && mp.team2 === team));
  TEAMS.forEach(team => {
    const locked = usedTeams.has(team);
    const chip = document.createElement("button");
    chip.className = "team-chip" + (locked ? " locked" : "") + (isMine(team) ? " selected" : "");
    // Clicking your current primary pick again clears it (unselect); a
    // used team is disabled; anything else selects it.
    const isPrimary = mp && mp.team === team;
    chip.innerHTML = `<span>${team}</span>`
      + (locked ? `<span class="lock-note">used</span>` : isPrimary ? `<span class="lock-note">tap to clear</span>` : "");
    chip.disabled = locked;
    chip.onclick = isPrimary ? () => clearPick(gw) : () => submitPick(gw, team);
    grid.appendChild(chip);
  });

  renderChipRow(gw, open, usedTeams);
}

function renderChipRow(gw, open, usedTeams) {
  const row = document.getElementById("chip-row");
  const half = halfOf(gw);
  const myPick = myPickFor(gw);
  const activeChip = myPick?.chip || null;
  // While a chip's entry form is open (clicked, but not yet played), show that
  // chip as highlighted. Purely visual -- nothing is saved and the "Chip set"
  // message is untouched until the form's play button is pressed.
  const editingChip = store.scorecardEditing ? "scorecard"
    : store.multipickEditing ? "multipick"
    : null;
  const displayActive = editingChip || activeChip;

  // Which chips have I already spent in this half? A chip is reserved as soon
  // as it's played on another week (including a future pre-pick), just like a
  // team -- so you can't put the same chip on two weeks. Only a forfeited /
  // abandoned week frees its chip up again to be re-played.
  const spentThisHalf = {};
  store.myPicks.forEach(p => {
    if (p.gameweek === gw || halfOf(p.gameweek) !== half || !p.chip) return;
    const forfeited = (store.results[`${p.gameweek}_${p.team}`] || []).includes("forfeit");
    if (!forfeited) spentThisHalf[p.chip] = p.gameweek;
  });

  let html = `<span class="chip-label">Chip — one per week, each usable once per half (H${half})</span>`;

  // "No chip" clears whatever is set this week.
  html += `<button class="chip-btn${displayActive ? "" : " selected"}" `
    + `data-chip="" ${(!open || !myPick) ? "disabled" : ""}>No chip</button>`;

  Object.entries(CHIPS).forEach(([id, meta]) => {
    const selected = displayActive === id;
    const spentOn = spentThisHalf[id];
    const lockedElsewhere = spentOn && !selected;   // used on another week this half
    const disabled = !open || !myPick || lockedElsewhere;
    html += `<button class="chip-btn${selected ? " selected" : ""}" data-chip="${id}" `
      + `title="${meta.desc}" ${disabled ? "disabled" : ""}>${meta.label}`
      + (lockedElsewhere ? `<span class="used">used GW${spentOn}</span>` : "")
      + `</button>`;
  });

  // Spell out what the active chip does, in full, once it's selected --
  // the button title only shows on hover, this stays put.
  if (displayActive && CHIPS[displayActive]) {
    html += `<p class="chip-desc"><strong>${CHIPS[displayActive].label}:</strong> ${CHIPS[displayActive].desc}</p>`;
  }

  // Scorecard needs a predicted scoreline. Show the entry form when
  // it's the active chip, or when the player has just clicked it.
  const showScorecard = (activeChip === "scorecard" || store.scorecardEditing) && myPick && open;
  if (showScorecard) {
    const sc = myPick?.scorecard || {};
    html += `<div class="scorecard-form">`
      + `<span class="chip-label" style="margin:0;">Exact score — predict ${myPick.team}'s result</span>`
      + `<span>${myPick.team}</span>`
      + `<input id="sc-for" type="number" min="0" max="20" value="${sc.for ?? ""}" />`
      + `<span>–</span>`
      + `<input id="sc-against" type="number" min="0" max="20" value="${sc.against ?? ""}" />`
      + `<span>opponent</span>`
      + `<button class="chip-btn" id="sc-save">Play Scorecard</button>`
      + `</div>`;
  }

  // Multipick needs a second team. Show a dropdown of teams still available to
  // you (excludes your first pick and any teams used in earlier weeks).
  const showMultipick = (activeChip === "multipick" || store.multipickEditing) && myPick && open;
  if (showMultipick) {
    const teamA = myPick.team;
    const currentB = myPick.chip === "multipick" ? myPick.team2 : null;
    const used = usedTeams || new Set();
    const options = TEAMS.filter(t => t !== teamA && (!used.has(t) || t === currentB));
    html += `<div class="scorecard-form">`
      + `<span class="chip-label" style="margin:0;">Second team — you score if ${teamA} or this team wins</span>`;
    if (options.length === 0) {
      html += `<span class="chip-hint" style="margin:0;">No other teams available to pair with.</span>`;
    } else {
      html += `<select id="mp-team">`
        + options.map(t => `<option value="${t}"${t === currentB ? " selected" : ""}>${t}</option>`).join("")
        + `</select>`
        + `<button class="chip-btn" id="mp-save">Play Multipick</button>`;
    }
    html += `</div>`;
  }

  if (!myPick) {
    html += `<span class="chip-hint">Pick a team first, then you can play a chip on it.</span>`;
  }

  row.innerHTML = html;
  row.querySelectorAll(".chip-btn[data-chip]:not([disabled])").forEach(btn => {
    const id = btn.dataset.chip || null;
    if (id === "scorecard") {
      // Reveal the score-entry form rather than saving immediately.
      btn.onclick = () => { store.scorecardEditing = true; store.multipickEditing = false; renderChipRow(gw, open, usedTeams); };
    } else if (id === "multipick") {
      // Reveal the second-team form rather than saving immediately.
      btn.onclick = () => { store.multipickEditing = true; store.scorecardEditing = false; renderChipRow(gw, open, usedTeams); };
    } else {
      btn.onclick = () => { store.scorecardEditing = false; store.multipickEditing = false; setChip(gw, id); };
    }
  });

  const saveBtn = document.getElementById("sc-save");
  if (saveBtn) {
    saveBtn.onclick = () => {
      const f = parseInt(document.getElementById("sc-for").value, 10);
      const a = parseInt(document.getElementById("sc-against").value, 10);
      const msg = document.getElementById("pick-msg");
      if (!Number.isInteger(f) || !Number.isInteger(a) || f < 0 || a < 0) {
        msg.textContent = "Enter both scores (0 or more) to play Scorecard.";
        msg.className = "msg error";
        return;
      }
      setChip(gw, "scorecard", { for: f, against: a });
    };
  }

  const mpSave = document.getElementById("mp-save");
  if (mpSave) {
    mpSave.onclick = () => {
      const t2 = document.getElementById("mp-team").value;
      const msg = document.getElementById("pick-msg");
      if (!t2) {
        msg.textContent = "Choose a second team to play Multipick.";
        msg.className = "msg error";
        return;
      }
      setChip(gw, "multipick", null, t2);
    };
  }
}

// The results table for the selected week. Locked weeks reveal everyone's
// picks + how they scored (the reveal "sheet" and the old history rolled into
// one); open weeks keep picks hidden.
function renderWeekResults(gw, open) {
  const title = document.getElementById("week-results-title");
  const note = document.getElementById("week-results-note");
  const table = document.getElementById("week-results-table");
  const body = document.getElementById("week-results-body");
  if (!body) return;
  title.textContent = `Gameweek ${gw} — Results`;

  if (open) {
    note.style.display = "";
    note.textContent = isCurrentGw(gw)
      ? "Everyone's picks stay hidden until this gameweek locks."
      : "Picks are hidden until this gameweek locks.";
    table.style.display = "none";
    body.innerHTML = "";
    return;
  }

  const results = store.results, goalsByKey = store.goalsByKey, concededByKey = store.concededByKey, popularity = store.popularity;
  const rows = store.allPicks
    .filter(p => p.gameweek === gw)
    .map(p => {
      const key = `${p.gameweek}_${p.team}`;
      const isMulti = p.chip === "multipick";
      const outcomes = isMulti
        ? multipickOutcomes(p.gameweek, p.team, p.team2, results)
        : (results[key] || []);
      const { pts, bonus, scorecardHit } = isMulti
        ? scoreMultipick(p.gameweek, p.team, p.team2, results, popularity)
        : scorePick(outcomes, goalsByKey[key], concededByKey[key], p.chip, p.scorecard, popularity[key]);
      let label;
      if (isMulti) {
        label = [p.team, p.team2].filter(Boolean)
          .map(t => `${t}: ${fmtResult(results[`${p.gameweek}_${t}`], goalsByKey[`${p.gameweek}_${t}`], concededByKey[`${p.gameweek}_${t}`])}`)
          .join(" · ");
      } else {
        label = fmtResult(outcomes, goalsByKey[key], concededByKey[key]);
      }
      const team = isMulti && p.team2 ? `${p.team} + ${p.team2}` : p.team;
      return { name: store.names[p.uid] || p.name, email: p.email, team, chip: p.chip, scorecard: p.scorecard, label, pts, bonus, scorecardHit };
    })
    .sort((a, b) => b.pts - a.pts);

  if (rows.length === 0) {
    note.style.display = "";
    note.textContent = "No picks were recorded for this gameweek.";
    table.style.display = "none";
    body.innerHTML = "";
    return;
  }

  note.style.display = "none";
  table.style.display = "";
  body.innerHTML = rows.map(r => {
    const cls = store.currentUser && r.email === store.currentUser.email ? ' class="me"' : "";
    const bonusTag = r.bonus ? `<span class="bonus-tag">&times;${BONUS_MULTIPLIER}</span>` : "";
    const hitTag = r.scorecardHit ? `<span class="bonus-tag" title="Exact score!">🎯+${SCORECARD_BONUS}</span>` : "";
    return `<tr${cls}><td>${r.name}</td><td>${r.team}${chipTag(r.chip, r.scorecard)}</td><td>${r.label}</td><td><strong>${r.pts}</strong>${bonusTag}${hitTag}</td></tr>`;
  }).join("");
}

// Fixtures for the selected week, mirrored into config/schedule by
// advance_gameweek.py (the FPL API can't be reached from the browser -- no
// CORS headers). Live scores update on the same schedule as games finish.
function renderFixtures(gw) {
  const titleEl = document.getElementById("fixtures-title");
  const el = document.getElementById("fixtures-list");
  if (!el) return;
  if (titleEl) titleEl.textContent = `GW${gw} Fixtures`;
  const list = fixturesOf(gw);
  if (!list || list.length === 0) {
    el.innerHTML = `<p class="empty">Fixtures not published yet.</p>`;
    return;
  }
  el.innerHTML = list.map(f => {
    const ko = f.kickoff ? f.kickoff.toDate() : null;
    // Only reveal a score once the match has actually kicked off (per the
    // current — possibly simulated — clock). Otherwise it's an upcoming
    // fixture: show the kickoff time. This keeps the box honest under the Time
    // Machine and in the mid-season test seed, where future weeks still carry
    // last season's scores in the data but haven't "happened" yet.
    const kicked = ko ? nowDate() >= ko : (f.started || f.finished);
    const hasScore = f.home_score != null && f.away_score != null;
    let meta;
    if (kicked && hasScore) {
      const cls = f.finished ? "fx-score" : "fx-score fx-live";
      meta = `<span class="${cls}">${f.home_score}–${f.away_score}</span>`;
    } else if (ko) {
      const day = ko.toLocaleDateString([], { weekday: "short" });
      const time = ko.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      meta = `${day} ${time}`;
    } else {
      meta = "TBC";
    }
    return `<div class="fixture"><span class="fx-match">${f.home} <span class="fx-v">v</span> ${f.away}</span><span class="fx-meta">${meta}</span></div>`;
  }).join("");
}

// Write (or change) my pick for a given gameweek. Works for the current week
// and any future week that's still before its own deadline -- the security
// rules enforce the deadline per gameweek. Keeps any chip already played.
async function submitPick(gw, team) {
  const msg = document.getElementById("pick-msg");
  msg.textContent = "Submitting...";
  msg.className = "msg";
  const existing = myPickFor(gw);
  const pickId = `${store.currentUser.uid}_gw${gw}`;
  const data = {
    uid: store.currentUser.uid,
    name: store.currentUser.displayName,
    email: store.currentUser.email,
    team,
    gameweek: gw,
  };
  // Changing your team keeps any chip (and its Scorecard prediction /
  // Multipick second team) you'd already played this week.
  if (existing?.chip) data.chip = existing.chip;
  if (existing?.chip === "scorecard" && existing.scorecard) data.scorecard = existing.scorecard;
  if (existing?.chip === "multipick" && existing.team2 && existing.team2 !== team) {
    data.team2 = existing.team2;
  }
  try {
    await setDoc(doc(db, "picks", pickId), data);
    msg.textContent = `Pick submitted: ${team}`;
    msg.className = "msg ok";
    await store.reload();
  } catch (e) {
    msg.textContent = `Couldn't submit: ${e.message}`;
    msg.className = "msg error";
  }
}

// Remove ("unselect") my pick for a gameweek. Only reachable before that
// week's deadline; the rules enforce the same. Frees the team + any chip.
async function clearPick(gw) {
  const msg = document.getElementById("pick-msg");
  msg.textContent = "Removing pick…";
  msg.className = "msg";
  try {
    await deleteDoc(doc(db, "picks", `${store.currentUser.uid}_gw${gw}`));
    msg.textContent = "Pick removed.";
    msg.className = "msg ok";
    await store.reload();
  } catch (e) {
    msg.textContent = `Couldn't remove pick: ${e.message}`;
    msg.className = "msg error";
  }
}

async function setChip(gw, chip, scorecard, team2) {
  const existing = myPickFor(gw);
  if (!existing) return;
  const msg = document.getElementById("pick-msg");
  msg.textContent = "Updating chip…";
  msg.className = "msg";
  const pickId = `${store.currentUser.uid}_gw${gw}`;
  const data = {
    uid: store.currentUser.uid,
    name: store.currentUser.displayName,
    email: store.currentUser.email,
    team: existing.team,
    gameweek: gw,
  };
  if (chip) data.chip = chip;   // omitting the field clears the chip
  if (chip === "scorecard" && scorecard) data.scorecard = scorecard;
  if (chip === "multipick" && team2) data.team2 = team2;
  try {
    await setDoc(doc(db, "picks", pickId), data);
    store.scorecardEditing = false;
    store.multipickEditing = false;
    msg.textContent = chip
      ? (chip === "scorecard"
          ? `Scorecard set: ${scorecard.for}–${scorecard.against}`
          : chip === "multipick"
            ? `Multipick set: ${existing.team} + ${team2}`
            : `Chip set: ${CHIPS[chip].label}`)
      : "Chip cleared.";
    msg.className = "msg ok";
    await store.reload();
  } catch (e) {
    msg.textContent = `Couldn't update chip: ${e.message}`;
    msg.className = "msg error";
  }
}

// Weekly league totals per player (email -> {name, points, played, won, ...}),
// from gameweek picks ONLY. Season-prediction bonuses are kept entirely
// separate (see computeSeasonPoints) and only combined in the end-of-season
// Final Table -- they never touch the live weekly standings.
export function computeWeeklyTotals(allPicks, results, goalsByKey, concededByKey, popularity) {
  const totals = {};
  allPicks.forEach(p => {
    const key = `${p.gameweek}_${p.team}`;
    const isMulti = p.chip === "multipick";
    const outcomes = isMulti
      ? multipickOutcomes(p.gameweek, p.team, p.team2, results)
      : (results[key] || []);
    const { pts, wins, chipPts, bonusPts } = isMulti
      ? scoreMultipick(p.gameweek, p.team, p.team2, results, popularity)
      : scorePick(outcomes, goalsByKey[key], concededByKey[key], p.chip, p.scorecard, popularity[key]);
    // A gameweek counts as "played" once the pick has a real result
    // (win/draw/loss). A forfeit means the team didn't play, so it
    // neither counts as played nor as a scoring week.
    const didPlay = outcomes.some(o => o === "win" || o === "draw" || o === "loss");

    if (!totals[p.email]) totals[p.email] = { name: store.names[p.uid] || p.name, points: 0, played: 0, won: 0, form: [], chips: [], chipPts: 0, bonusPts: 0 };
    const t = totals[p.email];
    t.points += pts;
    t.chipPts += chipPts;
    t.bonusPts += bonusPts;
    // Only count a chip once its week has actually played -- an unscored or
    // forfeited week doesn't count (and, elsewhere, doesn't consume the chip).
    if (didPlay && p.chip && CHIPS[p.chip]) t.chips.push({ gw: p.gameweek, chip: p.chip });
    if (didPlay) t.played += 1;
    if (wins > 0) t.won += 1;

    // One form letter per resolved gameweek (win beats draw beats loss;
    // a pure forfeit shows as F).
    let letter = null;
    if (outcomes.includes("win")) letter = "W";
    else if (outcomes.includes("draw")) letter = "D";
    else if (outcomes.includes("loss")) letter = "L";
    else if (outcomes.includes("forfeit")) letter = "F";
    if (letter) t.form.push({ gw: p.gameweek, letter });
  });
  Object.values(totals).forEach(t => t.form.sort((a, b) => a.gw - b.gw));
  return totals;
}

// Season-prediction points per player (email -> points), scored ONLY from the
// GW0 predictions against the final answers. Golden Boot correct = 10 (×2 if
// unique), champion correct = 5 (×2 if unique). Completely independent of the
// weekly table; combined with it only in the end-of-season Final Table.
export function computeSeasonPoints(seasonPicks, seasonResults) {
  const out = {};
  if (!seasonResults || !seasonPicks || !seasonPicks.length) return out;
  const gbCount = {}, chCount = {};
  seasonPicks.forEach(sp => {
    if (sp.goldenBootId != null) gbCount[sp.goldenBootId] = (gbCount[sp.goldenBootId] || 0) + 1;
    if (sp.champion) chCount[sp.champion] = (chCount[sp.champion] || 0) + 1;
  });
  seasonPicks.forEach(sp => {
    let add = 0;
    if (seasonResults.goldenBootId != null && sp.goldenBootId === seasonResults.goldenBootId) {
      add += GOLDEN_BOOT_BONUS * (gbCount[sp.goldenBootId] <= UNIQUE_THRESHOLD ? BONUS_MULTIPLIER : 1);
    }
    if (seasonResults.champion && sp.champion === seasonResults.champion) {
      add += CHAMPION_BONUS * (chCount[sp.champion] <= UNIQUE_THRESHOLD ? BONUS_MULTIPLIER : 1);
    }
    if (add) out[sp.email] = (out[sp.email] || 0) + add;
  });
  return out;
}

// The live league table -- WEEKLY points only. Season-prediction points are
// deliberately excluded here; they surface only in the Final Table at season
// end (see season.js), so mid-season standings can't be swung by predictions.
export function renderLeaderboard(allPicks, results, goalsByKey, concededByKey, popularity) {
  const totals = computeWeeklyTotals(allPicks, results, goalsByKey, concededByKey, popularity);

  const ppw = v => (v.played ? v.points / v.played : 0);
  const rows = Object.entries(totals)
    .map(([email, v]) => ({ email, ...v }))
    // Points first; ties broken by points-per-week-played, then by
    // number of weeks won.
    .sort((a, b) => b.points - a.points || ppw(b) - ppw(a) || b.won - a.won);

  const body = document.getElementById("leaderboard-body");
  body.innerHTML = "";
  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="10" class="empty">No scored picks yet.</td></tr>`;
    return;
  }
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    if (store.currentUser && r.email === store.currentUser.email) tr.className = "me";
    const perWeek = r.played ? (r.points / r.played).toFixed(2) : "–";
    const wStreak = trailingStreak(r.form, l => l === "W");
    const cStreak = trailingStreak(r.form, l => l !== "W");
    const crown = i === 0 && r.points > 0 ? ` <span class="crown" title="Top of the table">👑</span>` : "";
    const flame = wStreak >= 2 ? ` <span class="streak" title="${wStreak} winning weeks in a row">🔥${wStreak}</span>` : "";
    const ice = wStreak === 0 && cStreak >= 3 ? ` <span class="streak" title="${cStreak} weeks without a win">🧊</span>` : "";
    // Chips played: a count, with the specific chips + gameweeks on hover.
    const chipsTitle = r.chips
      .sort((a, b) => a.gw - b.gw)
      .map(c => `GW${c.gw} ${CHIPS[c.chip].label}`)
      .join(", ");
    const chipsCell = r.chips.length ? `<span title="${chipsTitle}">${r.chips.length}</span>` : "–";
    tr.innerHTML = `<td class="rank rank-${i + 1}">${i + 1}</td>`
      + `<td>${r.name}${crown}${flame}${ice}</td>`
      + `<td>${r.played}</td><td>${r.won}</td>`
      + `<td class="form-cell">${renderForm(r.form)}</td>`
      + `<td>${perWeek}</td>`
      + `<td>${chipsCell}</td><td>${r.chipPts || "–"}</td><td>${r.bonusPts || "–"}</td>`
      + `<td><strong>${r.points}</strong></td>`;
    body.appendChild(tr);
  });
}

function renderForm(form) {
  if (!form.length) return `<span class="empty" style="font-size:0.7rem;">–</span>`;
  return form.slice(-5)
    .map(f => `<span class="form-dot form-${f.letter}" title="GW${f.gw}: ${f.letter}">${f.letter}</span>`)
    .join("");
}

// Self-service display-name editor (Settings tab). Writes profiles/{uid};
// the name then resolves everywhere via store.names on the next load.
export function renderProfile() {
  const input = document.getElementById("profile-name");
  const btn = document.getElementById("profile-save");
  const msg = document.getElementById("profile-msg");
  if (!input || !btn) return;
  const uid = store.currentUser?.uid;
  input.value = store.names[uid] || store.currentUser?.displayName || "";
  btn.onclick = async () => {
    const name = input.value.trim();
    if (!name) { msg.textContent = "Enter a name."; msg.className = "msg error"; return; }
    try {
      await setDoc(doc(db, "profiles", uid), {
        uid, email: store.currentUser.email, name,
      }, { merge: true });
      msg.textContent = `Saved — you'll show as "${name}".`;
      msg.className = "msg ok";
      await store.reload();
    } catch (e) {
      msg.textContent = `Couldn't save: ${e.message}`;
      msg.className = "msg error";
    }
  };
}

// Fill the Rules tab's chip list straight from CHIPS, so it can never drift
// from the actual game. The prose alongside it lives in index.html.
export function renderRules() {
  const el = document.getElementById("rules-chips");
  if (!el) return;
  el.innerHTML = Object.entries(CHIPS)
    .map(([id, meta]) => `<p class="chip-desc"><span class="chip-tag chip-${id}">${meta.label}</span> ${meta.desc}</p>`)
    .join("");
}
