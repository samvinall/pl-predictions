// ---------------------------------------------------------------------------
// All the view code: the combined Gameweeks tab (week navigator + per-week
// pick UI, fixtures and results), the league table, and the write action
// (savePick) the pick UI triggers once you Save a staged draft. Reads shared
// state from `store` and refreshes via store.reload() only when needed, so it
// never imports the controller directly.
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
  renderWeek();   // ensureDraft() re-inits the draft for the new week (discards any unsaved edits)
}

// --- Draft (staged) pick helpers -------------------------------------------
// The draft is a local working copy of the selected week's pick. It only
// becomes real on Save; switching week rebuilds it from that week's saved pick.
function draftFromPick(gw) {
  const p = myPickFor(gw);
  return {
    gw,
    team: p?.team || null,
    chip: p?.chip || null,
    scorecard: p?.scorecard ? { for: p.scorecard.for, against: p.scorecard.against } : null,
    team2: p?.team2 || null,
  };
}
function ensureDraft(gw) {
  if (!store.draft || store.draft.gw !== gw) store.draft = draftFromPick(gw);
  return store.draft;
}
function pickSig(team, chip, team2, scorecard) {
  if (!team) return "none";
  let s = `${team}|${chip || ""}`;
  if (chip === "multipick") s += `|${team2 || ""}`;
  if (chip === "scorecard") s += `|${scorecard ? `${scorecard.for}-${scorecard.against}` : ""}`;
  return s;
}
function draftDirty(gw) {
  const d = store.draft, p = myPickFor(gw);
  return pickSig(d.team, d.chip, d.team2, d.scorecard)
       !== pickSig(p?.team || null, p?.chip || null, p?.team2 || null, p?.scorecard || null);
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
// full team grid + chip row + Save/Discard, all driven by the local draft;
// locked weeks show a one-line summary (the results table reveals everyone).
function renderPickPanel(gw, open, usedTeams) {
  const grid = document.getElementById("team-grid");
  const statusEl = document.getElementById("pick-status");
  const heading = document.getElementById("pick-heading");
  const intro = document.getElementById("pick-intro");
  const chipRow = document.getElementById("chip-row");
  const curEl = document.getElementById("current-selection");
  const actions = document.getElementById("pick-actions");
  const msg = document.getElementById("pick-msg");
  const saved = myPickFor(gw);
  grid.innerHTML = "";

  // "Current selection" box: always what's actually SAVED (never the draft).
  if (curEl) {
    if (saved) {
      const t = saved.chip === "multipick" && saved.team2 ? `${saved.team} + ${saved.team2}` : saved.team;
      curEl.innerHTML = `<span class="cs-label">Current selection</span><span class="cs-pick"><strong>${t}</strong>${chipTag(saved.chip, saved.scorecard)}</span>`;
    } else {
      curEl.innerHTML = `<span class="cs-label">Current selection</span><span class="cs-pick empty">nothing saved for GW${gw} yet</span>`;
    }
  }

  if (!open) {
    heading.textContent = `Gameweek ${gw}`;
    intro.style.display = "none";
    grid.style.display = "none";
    chipRow.style.display = "none";
    if (actions) actions.style.display = "none";
    if (msg) msg.textContent = "";
    statusEl.textContent = saved ? "This gameweek is locked — your pick is final." : "You didn't pick this week.";
    return;
  }

  const d = ensureDraft(gw);
  heading.textContent = isCurrentGw(gw) ? "Your Pick" : `Pick ahead · Gameweek ${gw}`;
  intro.style.display = "";
  grid.style.display = "";
  chipRow.style.display = "";
  if (actions) actions.style.display = "";

  const dirty = draftDirty(gw);
  statusEl.textContent = dirty
    ? "Unsaved changes — press Save to lock them in."
    : (saved ? "Change your team or chip below, then Save."
             : `Choose a team${isCurrentGw(gw) ? "" : " to pre-pick"}, then press Save.`);

  const isMine = (team) => d.team === team || (d.chip === "multipick" && d.team2 === team);
  TEAMS.forEach(team => {
    const locked = usedTeams.has(team);
    const btn = document.createElement("button");
    const isPrimary = d.team === team;
    btn.className = "team-chip" + (locked ? " locked" : "") + (isMine(team) ? " selected" : "");
    // Clicking your currently-drafted team again clears it; a used team is
    // disabled; anything else stages it. Nothing writes until Save.
    btn.innerHTML = `<span>${team}</span>`
      + (locked ? `<span class="lock-note">used</span>` : isPrimary ? `<span class="lock-note">tap to clear</span>` : "");
    btn.disabled = locked;
    btn.onclick = () => {
      if (d.team === team) { d.team = null; d.chip = null; d.scorecard = null; d.team2 = null; }
      else d.team = team;
      renderWeek();
    };
    grid.appendChild(btn);
  });

  renderChipRow(gw, usedTeams);
  renderPickActions(gw, dirty);
}

// Chip picker for the draft. Selecting a chip / editing its form just updates
// the draft (no write); the Save button persists everything at once.
function renderChipRow(gw, usedTeams) {
  const row = document.getElementById("chip-row");
  const half = halfOf(gw);
  const d = store.draft;
  const displayActive = d.chip || null;
  const hasTeam = !!d.team;

  // Chips reserved by OTHER (saved) weeks this half -- can't be reused. A
  // forfeited week frees its chip up again.
  const spentThisHalf = {};
  store.myPicks.forEach(p => {
    if (p.gameweek === gw || halfOf(p.gameweek) !== half || !p.chip) return;
    const forfeited = (store.results[`${p.gameweek}_${p.team}`] || []).includes("forfeit");
    if (!forfeited) spentThisHalf[p.chip] = p.gameweek;
  });

  let html = `<span class="chip-label">Chip — one per week, each usable once per half (H${half})</span>`;
  html += `<button class="chip-btn${displayActive ? "" : " selected"}" data-chip="" ${hasTeam ? "" : "disabled"}>No chip</button>`;
  Object.entries(CHIPS).forEach(([id, meta]) => {
    const selected = displayActive === id;
    const spentOn = spentThisHalf[id];
    const lockedElsewhere = spentOn && !selected;
    const disabled = !hasTeam || lockedElsewhere;
    html += `<button class="chip-btn${selected ? " selected" : ""}" data-chip="${id}" `
      + `title="${meta.desc}" ${disabled ? "disabled" : ""}>${meta.label}`
      + (lockedElsewhere ? `<span class="used">used GW${spentOn}</span>` : "")
      + `</button>`;
  });

  if (displayActive && CHIPS[displayActive]) {
    html += `<p class="chip-desc"><strong>${CHIPS[displayActive].label}:</strong> ${CHIPS[displayActive].desc}</p>`;
  }

  // Scorecard: predicted scoreline, bound to the draft (no separate save).
  if (displayActive === "scorecard" && hasTeam) {
    const sc = d.scorecard || {};
    html += `<div class="scorecard-form">`
      + `<span class="chip-label" style="margin:0;">Exact score — predict ${d.team}'s result</span>`
      + `<span>${d.team}</span>`
      + `<input id="sc-for" type="number" min="0" max="20" value="${sc.for ?? ""}" />`
      + `<span>–</span>`
      + `<input id="sc-against" type="number" min="0" max="20" value="${sc.against ?? ""}" />`
      + `<span>opponent</span>`
      + `</div>`;
  }

  // Multipick: second team, bound to the draft.
  if (displayActive === "multipick" && hasTeam) {
    const teamA = d.team;
    const used = usedTeams || new Set();
    const options = TEAMS.filter(t => t !== teamA && (!used.has(t) || t === d.team2));
    html += `<div class="scorecard-form">`
      + `<span class="chip-label" style="margin:0;">Second team — you score if ${teamA} or this team wins</span>`;
    if (options.length === 0) {
      html += `<span class="chip-hint" style="margin:0;">No other teams available to pair with.</span>`;
    } else {
      html += `<select id="mp-team"><option value="">— choose —</option>`
        + options.map(t => `<option value="${t}"${t === d.team2 ? " selected" : ""}>${t}</option>`).join("")
        + `</select>`;
    }
    html += `</div>`;
  }

  if (!hasTeam) {
    html += `<span class="chip-hint">Pick a team first, then you can add a chip.</span>`;
  }

  row.innerHTML = html;
  row.querySelectorAll(".chip-btn[data-chip]:not([disabled])").forEach(btn => {
    btn.onclick = () => {
      d.chip = btn.dataset.chip || null;
      if (d.chip !== "scorecard") d.scorecard = null;
      if (d.chip !== "multipick") d.team2 = null;
      renderWeek();
    };
  });
  // Form inputs update the draft in place, without a re-render (keeps focus).
  const scFor = document.getElementById("sc-for"), scAgainst = document.getElementById("sc-against");
  const syncSc = () => {
    const f = parseInt(scFor.value, 10), a = parseInt(scAgainst.value, 10);
    d.scorecard = { for: Number.isInteger(f) ? f : null, against: Number.isInteger(a) ? a : null };
  };
  if (scFor) scFor.oninput = syncSc;
  if (scAgainst) scAgainst.oninput = syncSc;
  const mpSel = document.getElementById("mp-team");
  if (mpSel) mpSel.onchange = () => { d.team2 = mpSel.value || null; };
}

// Save / Discard for the draft. Save is always available while the week is
// open; Discard reverts to the saved pick and is only enabled when dirty.
function renderPickActions(gw, dirty) {
  const el = document.getElementById("pick-actions");
  if (!el) return;
  el.innerHTML = `<button id="pick-save">Save pick</button>`
    + `<button class="ghost" id="pick-discard"${dirty ? "" : " disabled"}>Discard changes</button>`;
  document.getElementById("pick-save").onclick = () => savePick(gw);
  const dc = document.getElementById("pick-discard");
  if (dc && dirty) dc.onclick = () => { store.draft = draftFromPick(gw); renderWeek(); };
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

// Apply a pick change to the in-memory datasets so the UI can update instantly
// without re-reading everything from Firestore. `data` is the new pick (or null
// to remove it). Changing an open week's pick affects nothing scored, so this
// is all the state a re-render needs.
function applyMyPickLocally(gw, data) {
  const uid = store.currentUser.uid;
  store.myPicks = store.myPicks.filter(p => p.gameweek !== gw);
  store.allPicks = store.allPicks.filter(p => !(p.uid === uid && p.gameweek === gw));
  if (data) { store.myPicks.push(data); store.allPicks.push(data); }
}

// Persist a pick write in the background: the local state + UI have already
// updated optimistically, so we only need to catch a failure and re-sync.
async function persist(writePromise, msg, okText) {
  msg.textContent = okText;
  msg.className = "msg ok";
  try {
    await writePromise;
  } catch (e) {
    msg.textContent = `Couldn't save: ${e.message}`;
    msg.className = "msg error";
    await store.reload();   // fall back to server truth on failure
  }
}

// Save the staged draft for a gameweek. Writes (or, if the team was cleared,
// deletes) the pick, only before that week's deadline -- the rules enforce it.
// Updates local state + re-renders instantly, persisting in the background.
function savePick(gw) {
  const d = store.draft;
  const msg = document.getElementById("pick-msg");
  const saved = myPickFor(gw);
  const pickRef = doc(db, "picks", `${store.currentUser.uid}_gw${gw}`);

  // Cleared team -> remove the pick (nothing to do if there wasn't one).
  if (!d.team) {
    if (!saved) { msg.textContent = "Pick a team first."; msg.className = "msg error"; return; }
    applyMyPickLocally(gw, null);
    store.draft = draftFromPick(gw);
    renderWeek();
    persist(deleteDoc(pickRef), document.getElementById("pick-msg"), "Pick removed.");
    return;
  }
  // Chip forms must be complete before they can be saved.
  if (d.chip === "scorecard" && !(d.scorecard
      && Number.isInteger(d.scorecard.for) && Number.isInteger(d.scorecard.against)
      && d.scorecard.for >= 0 && d.scorecard.against >= 0)) {
    msg.textContent = "Enter both scores (0 or more) for Scorecard, or choose another chip.";
    msg.className = "msg error";
    return;
  }
  if (d.chip === "multipick" && !d.team2) {
    msg.textContent = "Choose a second team for Multipick, or choose another chip.";
    msg.className = "msg error";
    return;
  }

  const data = {
    uid: store.currentUser.uid,
    name: store.currentUser.displayName,
    email: store.currentUser.email,
    team: d.team,
    gameweek: gw,
  };
  if (d.chip) data.chip = d.chip;
  if (d.chip === "scorecard") data.scorecard = { for: d.scorecard.for, against: d.scorecard.against };
  if (d.chip === "multipick") data.team2 = d.team2;

  applyMyPickLocally(gw, data);
  store.draft = draftFromPick(gw);   // draft now matches the saved pick (not dirty)
  renderWeek();
  const label = d.chip && CHIPS[d.chip] ? ` (${CHIPS[d.chip].label})` : "";
  persist(setDoc(pickRef, data), document.getElementById("pick-msg"), `Saved: ${data.team}${label}`);
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
// GW0 predictions against the final answers. Golden Boot + champion each score
// GOLDEN_BOOT_BONUS / CHAMPION_BONUS (×2 if unique). Completely independent of
// the weekly table; combined with it only in the end-of-season Final Table.
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

// Fill the Rules tab's dynamic bits (chip list + season-prediction points)
// straight from config, so they can never drift from the actual game. The
// surrounding prose lives in index.html.
export function renderRules() {
  const chips = document.getElementById("rules-chips");
  if (chips) {
    chips.innerHTML = Object.entries(CHIPS)
      .map(([id, meta]) => `<p class="chip-desc"><span class="chip-tag chip-${id}">${meta.label}</span> ${meta.desc}</p>`)
      .join("");
  }
  const season = document.getElementById("rules-season");
  if (season) {
    const gbU = GOLDEN_BOOT_BONUS * BONUS_MULTIPLIER;
    const chU = CHAMPION_BONUS * BONUS_MULTIPLIER;
    season.innerHTML = `<ul class="rules-list">
      <li>Before the season kicks off, predict the <strong>Golden Boot</strong> winner (the league's top scorer) and, optionally, the <strong>champion</strong>. Set them on the <strong>Season</strong> tab; changeable until the transfer window shuts, then locked.</li>
      <li><strong>Golden Boot:</strong> ${GOLDEN_BOOT_BONUS} pts if you call it right — <strong>${gbU}</strong> if you're the only one who did.</li>
      <li><strong>Champion:</strong> ${CHAMPION_BONUS} pts if right — <strong>${chU}</strong> if unique.</li>
      <li>Predictions stay <strong>hidden</strong> from everyone else until the lock, and they don't touch the weekly table — they're added only in the end-of-season Final Table.</li>
    </ul>`;
  }
}
