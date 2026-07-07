// ---------------------------------------------------------------------------
// All the view code: rendering the pick panel, chip row, sheet, league table,
// history and fixtures, plus the two write actions (submitPick / setChip) that
// the pick UI triggers. Reads shared state from `store` and refreshes via
// store.reload() after a write, so it never imports the controller directly.
// ---------------------------------------------------------------------------
import {
  TEAMS, CHIPS, UNLOCK_GAMEWEEK, BONUS_MULTIPLIER, SCORECARD_BONUS, halfOf,
} from "./config.js";
import { db, doc, getDoc, setDoc } from "./firebase.js";
import { store } from "./store.js";
import { scorePick, fmtCountdown, trailingStreak } from "./scoring.js";

// Live-ticking countdown to the deadline. Flips the whole app to its
// locked state (revealing picks) the moment it expires.
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

// Per-gameweek look-back. Everyone's past picks are already loaded (the
// rules allow reading picks from earlier gameweeks, and the current one
// once it's locked), so this is a pure view over data we already have.
export function renderHistory(allPicks, results, goalsByKey, concededByKey, isOpen, popularity) {
  const card = document.getElementById("history-card");
  const selEl = document.getElementById("history-gw");
  const bodyEl = document.getElementById("history-body");

  // Gameweeks we can actually show: any earlier one that has picks, plus
  // the current gameweek once its deadline has passed (picks readable).
  const shown = new Set(
    allPicks
      .map(p => p.gameweek)
      .filter(gw => gw < store.currentConfig.gameweek || (gw === store.currentConfig.gameweek && !isOpen))
  );
  const sortedGws = Array.from(shown).sort((a, b) => a - b);
  if (sortedGws.length === 0) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";

  const renderWeek = (gw) => {
    const rows = allPicks
      .filter(p => p.gameweek === gw)
      .map(p => {
        const key = `${p.gameweek}_${p.team}`;
        const outcomes = results[key] || [];
        const { pts, bonus, scorecardHit } = scorePick(outcomes, goalsByKey[key], concededByKey[key], p.chip, p.scorecard, popularity[key]);
        let label;
        if (outcomes.length === 0) label = "Pending";
        else if (outcomes.includes("forfeit")) label = "Forfeit";
        else label = outcomes.map(o => o[0].toUpperCase() + o.slice(1)).join(", ");
        return { name: p.name, email: p.email, team: p.team, chip: p.chip, scorecard: p.scorecard, label, pts, bonus, scorecardHit };
      })
      .sort((a, b) => b.pts - a.pts);

    bodyEl.innerHTML = rows.map(r => {
      const cls = store.currentUser && r.email === store.currentUser.email ? ' class="me"' : "";
      const bonusTag = r.bonus ? `<span class="bonus-tag">&times;${BONUS_MULTIPLIER}</span>` : "";
      const hitTag = r.scorecardHit ? `<span class="bonus-tag" title="Exact score!">🎯+${SCORECARD_BONUS}</span>` : "";
      return `<tr${cls}><td>${r.name}</td><td>${r.team}${chipTag(r.chip, r.scorecard)}</td><td>${r.label}</td><td><strong>${r.pts}</strong>${bonusTag}${hitTag}</td></tr>`;
    }).join("");
  };

  // Rebuild the selector, keeping the current choice if it's still valid,
  // otherwise defaulting to the most recent week.
  const prev = selEl.value ? parseInt(selEl.value, 10) : null;
  const defaultGw = (prev && shown.has(prev)) ? prev : sortedGws[sortedGws.length - 1];
  selEl.innerHTML = sortedGws
    .map(gw => `<option value="${gw}"${gw === defaultGw ? " selected" : ""}>Gameweek ${gw}</option>`)
    .join("");
  selEl.onchange = () => renderWeek(parseInt(selEl.value, 10));
  renderWeek(defaultGw);
}

// Fixtures are mirrored into config/fixtures by advance_gameweek.py
// (the FPL API can't be reached from the browser -- no CORS headers),
// and refreshed on the same schedule so scores update as games finish.
export async function renderFixtures() {
  const titleEl = document.getElementById("fixtures-title");
  const el = document.getElementById("fixtures-list");
  titleEl.textContent = `GW${store.currentConfig.gameweek} Fixtures`;
  let snap;
  try {
    snap = await getDoc(doc(db, "config", "fixtures"));
  } catch (e) {
    el.innerHTML = `<p class="empty">Couldn't load fixtures.</p>`;
    return;
  }
  if (!snap.exists()) {
    el.innerHTML = `<p class="empty">Fixtures not published yet.</p>`;
    return;
  }
  const data = snap.data();
  const list = data.fixtures || [];
  if (list.length === 0) {
    el.innerHTML = `<p class="empty">No fixtures listed for this gameweek.</p>`;
    return;
  }
  // If the mirrored fixtures are for a different gameweek than the one
  // that's open, the sync just hasn't caught up yet -- say so.
  const staleNote = data.gameweek !== store.currentConfig.gameweek
    ? `<p class="empty">Showing GW${data.gameweek} — fixtures for the open gameweek aren't published yet.</p>`
    : "";

  el.innerHTML = staleNote + list.map(f => {
    let meta;
    if ((f.started || f.finished) && f.home_score != null && f.away_score != null) {
      const cls = f.finished ? "fx-score" : "fx-score fx-live";
      meta = `<span class="${cls}">${f.home_score}–${f.away_score}</span>`;
    } else if (f.kickoff) {
      const d = f.kickoff.toDate();
      const day = d.toLocaleDateString([], { weekday: "short" });
      const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      meta = `${day} ${time}`;
    } else {
      meta = "TBC";
    }
    return `<div class="fixture"><span class="fx-match">${f.home} <span class="fx-v">v</span> ${f.away}</span><span class="fx-meta">${meta}</span></div>`;
  }).join("");
}

export function renderPickPanel(isOpen, usedTeams) {
  const grid = document.getElementById("team-grid");
  const statusEl = document.getElementById("pick-status");
  grid.innerHTML = "";

  if (store.myPickThisWeek) {
    statusEl.textContent = isOpen
      ? `Current pick: ${store.myPickThisWeek.team} for GW${store.currentConfig.gameweek} — you can still change this until kickoff.`
      : `Locked in: ${store.myPickThisWeek.team} for GW${store.currentConfig.gameweek}`;
  } else if (!isOpen) {
    statusEl.textContent = "Picking window has closed for this gameweek.";
  } else {
    statusEl.textContent = "Choose a team below. You can change your mind anytime before kickoff of the first match.";
  }

  TEAMS.forEach(team => {
    const locked = store.currentConfig.gameweek < UNLOCK_GAMEWEEK && usedTeams.has(team);
    const chip = document.createElement("button");
    chip.className = "team-chip" + (locked ? " locked" : "") + (store.myPickThisWeek?.team === team ? " selected" : "");
    chip.innerHTML = `<span>${team}</span>` + (locked ? `<span class="lock-note">used</span>` : "");
    chip.disabled = locked || !isOpen;
    chip.onclick = () => submitPick(team);
    grid.appendChild(chip);
  });

  renderChipRow(isOpen);
}

function renderChipRow(isOpen) {
  const row = document.getElementById("chip-row");
  const half = halfOf(store.currentConfig.gameweek);
  const activeChip = store.myPickThisWeek?.chip || null;
  // While the Scorecard entry form is open (clicked, but not yet played),
  // show Scorecard as the highlighted chip. This is purely visual --
  // nothing is saved and the "Chip set" message is left untouched until
  // "Play Scorecard" is pressed.
  const displayActive = store.scorecardEditing ? "scorecard" : activeChip;

  // Which chips have I already spent in this half (on a different week)?
  const spentThisHalf = {};
  store.myPicks.forEach(p => {
    if (p.gameweek !== store.currentConfig.gameweek && halfOf(p.gameweek) === half && p.chip) {
      spentThisHalf[p.chip] = p.gameweek;
    }
  });

  let html = `<span class="chip-label">Chip — one per week, each usable once per half (H${half})</span>`;

  // "No chip" clears whatever is set this week.
  html += `<button class="chip-btn${displayActive ? "" : " selected"}" `
    + `data-chip="" ${(!isOpen || !store.myPickThisWeek) ? "disabled" : ""}>No chip</button>`;

  Object.entries(CHIPS).forEach(([id, meta]) => {
    const selected = displayActive === id;
    const spentOn = spentThisHalf[id];
    const lockedElsewhere = spentOn && !selected;   // used on another week this half
    const disabled = !isOpen || !store.myPickThisWeek || lockedElsewhere;
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
  const showScorecard = (activeChip === "scorecard" || store.scorecardEditing) && store.myPickThisWeek && isOpen;
  if (showScorecard) {
    const sc = store.myPickThisWeek?.scorecard || {};
    html += `<div class="scorecard-form">`
      + `<span class="chip-label" style="margin:0;">Exact score — predict ${store.myPickThisWeek.team}'s result</span>`
      + `<span>${store.myPickThisWeek.team}</span>`
      + `<input id="sc-for" type="number" min="0" max="20" value="${sc.for ?? ""}" />`
      + `<span>–</span>`
      + `<input id="sc-against" type="number" min="0" max="20" value="${sc.against ?? ""}" />`
      + `<span>opponent</span>`
      + `<button class="chip-btn" id="sc-save">Play Scorecard</button>`
      + `</div>`;
  }

  if (!store.myPickThisWeek) {
    html += `<span class="chip-hint">Pick a team first, then you can play a chip on it.</span>`;
  } else if (!isOpen) {
    html += `<span class="chip-hint">Chips lock at the deadline along with your pick.</span>`;
  }

  row.innerHTML = html;
  row.querySelectorAll(".chip-btn[data-chip]:not([disabled])").forEach(btn => {
    const id = btn.dataset.chip || null;
    if (id === "scorecard") {
      // Reveal the score-entry form rather than saving immediately.
      btn.onclick = () => { store.scorecardEditing = true; renderChipRow(isOpen); };
    } else {
      btn.onclick = () => { store.scorecardEditing = false; setChip(id); };
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
      setChip("scorecard", { for: f, against: a });
    };
  }
}

async function setChip(chip, scorecard) {
  if (!store.myPickThisWeek) return;
  const msg = document.getElementById("pick-msg");
  msg.textContent = "Updating chip…";
  msg.className = "msg";
  const pickId = `${store.currentUser.uid}_gw${store.currentConfig.gameweek}`;
  const data = {
    uid: store.currentUser.uid,
    name: store.currentUser.displayName,
    email: store.currentUser.email,
    team: store.myPickThisWeek.team,
    gameweek: store.currentConfig.gameweek,
  };
  if (chip) data.chip = chip;   // omitting the field clears the chip
  if (chip === "scorecard" && scorecard) data.scorecard = scorecard;
  try {
    await setDoc(doc(db, "picks", pickId), data);
    store.scorecardEditing = false;
    msg.textContent = chip
      ? (chip === "scorecard"
          ? `Scorecard set: ${scorecard.for}–${scorecard.against}`
          : `Chip set: ${CHIPS[chip].label}`)
      : "Chip cleared.";
    msg.className = "msg ok";
    await store.reload();
  } catch (e) {
    msg.textContent = `Couldn't update chip: ${e.message}`;
    msg.className = "msg error";
  }
}

async function submitPick(team) {
  const msg = document.getElementById("pick-msg");
  msg.textContent = "Submitting...";
  msg.className = "msg";
  const pickId = `${store.currentUser.uid}_gw${store.currentConfig.gameweek}`;
  const data = {
    uid: store.currentUser.uid,
    name: store.currentUser.displayName,
    email: store.currentUser.email,
    team,
    gameweek: store.currentConfig.gameweek,
  };
  // Changing your team keeps any chip (and Scorecard prediction) you'd
  // already played this week.
  if (store.myPickThisWeek?.chip) data.chip = store.myPickThisWeek.chip;
  if (store.myPickThisWeek?.chip === "scorecard" && store.myPickThisWeek.scorecard) {
    data.scorecard = store.myPickThisWeek.scorecard;
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

export function renderSheet(weekPicks, isOpen) {
  const el = document.getElementById("sheet-list");
  el.innerHTML = "";
  if (isOpen) {
    el.innerHTML = `<p class="empty">Picks stay hidden from each other until the gameweek locks.</p>`;
    return;
  }
  if (weekPicks.length === 0) {
    el.innerHTML = `<p class="empty">No picks recorded for this gameweek yet.</p>`;
    return;
  }
  weekPicks.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "pick-tile";
    row.innerHTML = `<span class="pick-num">${i + 1}</span>`
      + `<span>${p.name} &mdash; <strong>${p.team}</strong>${chipTag(p.chip, p.scorecard)}</span>`;
    el.appendChild(row);
  });
}

export function renderLeaderboard(allPicks, results, goalsByKey, concededByKey, popularity) {
  const totals = {}; // email -> {name, points, played, won, form:[{gw,letter}]}
  allPicks.forEach(p => {
    const key = `${p.gameweek}_${p.team}`;
    const outcomes = results[key] || [];
    const { pts, wins, chipPts, bonusPts } = scorePick(outcomes, goalsByKey[key], concededByKey[key], p.chip, p.scorecard, popularity[key]);
    // A gameweek counts as "played" once the pick has a real result
    // (win/draw/loss). A forfeit means the team didn't play, so it
    // neither counts as played nor as a scoring week.
    const didPlay = outcomes.some(o => o === "win" || o === "draw" || o === "loss");

    if (!totals[p.email]) totals[p.email] = { name: p.name, points: 0, played: 0, won: 0, form: [], chips: [], chipPts: 0, bonusPts: 0 };
    const t = totals[p.email];
    t.points += pts;
    t.chipPts += chipPts;
    t.bonusPts += bonusPts;
    if (p.chip && CHIPS[p.chip]) t.chips.push({ gw: p.gameweek, chip: p.chip });
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
