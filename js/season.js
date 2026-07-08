// ---------------------------------------------------------------------------
// The "Season" tab: the GW0 season-long predictions (Golden Boot + champion),
// the pre-lock picker, the post-lock reveal, and the live PL top-4 + top
// scorers panel. Predictions lock at the transfer-window close and are hidden
// from others until then (enforced in firestore.rules).
// ---------------------------------------------------------------------------
import { TEAMS, GOLDEN_BOOT_BONUS, CHAMPION_BONUS, BONUS_MULTIPLIER } from "./config.js";
import { db, doc, setDoc } from "./firebase.js";
import { store } from "./store.js";

const playerLabel = p => `${p.name} (${p.team})`;
const escapeAttr = s => String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// state: { open, deadline, results, standings, players, seasonPicks, myPick, finalTable }
export function renderSeason(state) {
  renderStandings(state.standings);
  renderFinalTable(state.finalTable);

  const body = document.getElementById("season-body");
  const nudge = document.getElementById("season-nudge");
  const seasonBtn = document.getElementById("tab-btn-season");
  if (!body) return;
  const my = state.myPick;

  // Prominent nudge while predictions are open and you haven't made one; goes
  // quiet (and the tab stops flashing for attention) once picked or locked.
  const needsPick = state.open && !(my && (my.goldenBootId != null || my.champion));
  if (nudge) {
    if (needsPick) {
      nudge.className = "season-nudge";
      nudge.style.display = "";
      const when = state.deadline ? ` (locks ${state.deadline.toLocaleDateString([], { day: "numeric", month: "short" })})` : "";
      nudge.innerHTML = `⚽ <strong>Set your season predictions</strong>${when} — <button class="link-btn" id="season-nudge-go">open the Season tab →</button>`;
      const go = document.getElementById("season-nudge-go");
      if (go) go.onclick = () => store.selectTab && store.selectTab("season");
    } else {
      nudge.style.display = "none";
      nudge.innerHTML = "";
    }
  }
  if (seasonBtn) seasonBtn.classList.toggle("attention", needsPick);

  body.innerHTML = state.open ? pickerHtml(my, state.players, state.deadline) : lockedHtml(state);
  if (state.open) wirePicker(state.players);
}

function pickerHtml(my, players, deadline) {
  const dl = deadline ? ` Locks ${deadline.toLocaleString()}.` : "";
  let html = `<p class="eyebrow">Pick the season's top scorer and (optionally) the champion. Changeable until the transfer window shuts, hidden from everyone else until then.${dl}</p>`;
  if (!players || players.length === 0) {
    html += `<p class="empty">The player list hasn't been published yet — check back shortly.</p>`;
    return html;
  }
  const gbLabel = my && my.goldenBootId != null
    ? (players.find(p => p.id === my.goldenBootId) ? playerLabel(players.find(p => p.id === my.goldenBootId)) : my.goldenBootName)
    : "";
  const champ = my?.champion || "";
  html += `<datalist id="players-datalist">`
    + players.map(p => `<option value="${escapeAttr(playerLabel(p))}"></option>`).join("")
    + `</datalist>`
    + `<div style="display:flex; flex-wrap:wrap; gap:0.8rem; align-items:end; margin-top:0.6rem;">`
    + `<div><label class="eyebrow" for="gb-input">Golden Boot — top scorer (${GOLDEN_BOOT_BONUS} pts, ${GOLDEN_BOOT_BONUS * BONUS_MULTIPLIER} if unique)</label><br/>`
    + `<input list="players-datalist" id="gb-input" value="${escapeAttr(gbLabel)}" placeholder="type a player" style="padding:0.5rem; font-family:'JetBrains Mono',monospace; min-width:15rem;" /></div>`
    + `<div><label class="eyebrow" for="champ-input">Champion (${CHAMPION_BONUS} pts, ${CHAMPION_BONUS * BONUS_MULTIPLIER} if unique)</label><br/>`
    + `<select id="champ-input" style="padding:0.5rem; font-family:'JetBrains Mono',monospace;">`
    + `<option value="">— none —</option>`
    + TEAMS.map(t => `<option value="${t}"${t === champ ? " selected" : ""}>${t}</option>`).join("")
    + `</select></div>`
    + `<button id="season-save">Save predictions</button>`
    + `</div><div class="msg" id="season-msg"></div>`;
  return html;
}

function wirePicker(players) {
  const saveBtn = document.getElementById("season-save");
  if (!saveBtn) return;
  const byLabel = new Map((players || []).map(p => [playerLabel(p), p]));
  saveBtn.onclick = async () => {
    const msg = document.getElementById("season-msg");
    const gbVal = document.getElementById("gb-input").value.trim();
    const champ = document.getElementById("champ-input").value;
    let gb = null;
    if (gbVal) {
      gb = byLabel.get(gbVal);
      if (!gb) { msg.textContent = "Pick your Golden Boot player from the list."; msg.className = "msg error"; return; }
    }
    if (!gb && !champ) { msg.textContent = "Make at least one prediction."; msg.className = "msg error"; return; }
    const data = { uid: store.currentUser.uid, email: store.currentUser.email, name: store.currentUser.displayName };
    if (gb) { data.goldenBootId = gb.id; data.goldenBootName = gb.name; }
    if (champ) data.champion = champ;
    try {
      await setDoc(doc(db, "season_picks", store.currentUser.uid), data);   // full set: blanks clear
      msg.textContent = "Season predictions saved.";
      msg.className = "msg ok";
      await store.reload();
    } catch (e) {
      msg.textContent = `Couldn't save: ${e.message}`;
      msg.className = "msg error";
    }
  };
}

function lockedHtml(state) {
  const results = state.results;
  const picks = state.seasonPicks || [];
  let html = `<p class="eyebrow">Predictions are locked.</p>`;

  if (results && (results.goldenBootName || results.champion)) {
    html += `<div class="pick-tile"><span>Final — Golden Boot: <strong>${results.goldenBootName || "—"}</strong>`
      + ` · Champion: <strong>${results.champion || "—"}</strong></span></div>`;
  }

  if (picks.length === 0) {
    html += `<p class="empty">No season predictions were made.</p>`;
    return html;
  }

  html += `<p class="eyebrow" style="margin-top:1rem;">Everyone's predictions</p>`
    + `<div class="table-scroll"><table><thead><tr><th>Player</th><th>Golden Boot</th><th>Champion</th></tr></thead><tbody>`
    + picks.map(sp => {
        const name = store.names[sp.uid] || sp.name || sp.email;
        const gbHit = results && results.goldenBootId != null && sp.goldenBootId === results.goldenBootId;
        const chHit = results && results.champion && sp.champion === results.champion;
        const gb = sp.goldenBootName ? `${sp.goldenBootName}${gbHit ? " ✅" : ""}` : "—";
        const ch = sp.champion ? `${sp.champion}${chHit ? " ✅" : ""}` : "—";
        const me = store.currentUser && sp.email === store.currentUser.email ? ' class="me"' : "";
        return `<tr${me}><td>${name}</td><td>${gb}</td><td>${ch}</td></tr>`;
      }).join("")
    + `</tbody></table></div>`;
  return html;
}

// End-of-season Final Table: weekly points + season-prediction points combined
// into the definitive standings. Only shown once the admin has published the
// season answers (finalTable is null before then), so it can't affect the live
// weekly league table during the season.
function renderFinalTable(finalTable) {
  const card = document.getElementById("final-table-card");
  const body = document.getElementById("final-table-body");
  if (!card || !body) return;
  if (!finalTable || finalTable.length === 0) {
    card.style.display = "none";
    body.innerHTML = "";
    return;
  }
  card.style.display = "";
  body.innerHTML = finalTable.map((r, i) => {
    const me = store.currentUser && r.email === store.currentUser.email ? ' class="me"' : "";
    return `<tr${me}><td class="rank rank-${i + 1}">${i + 1}</td><td>${r.name}</td>`
      + `<td>${r.weekly}</td><td>${r.season || "–"}</td><td><strong>${r.total}</strong></td></tr>`;
  }).join("");
}

function renderStandings(standings) {
  const tEl = document.getElementById("standings-body");
  const sEl = document.getElementById("topscorers-body");
  if (tEl) {
    const table = (standings && standings.table) || [];
    tEl.innerHTML = table.length === 0
      ? `<p class="empty">Standings not available yet.</p>`
      : `<div class="table-scroll"><table><thead><tr><th>#</th><th>Team</th><th>Pld</th><th>GD</th><th>Pts</th></tr></thead><tbody>`
        + table.slice(0, 4).map(r => `<tr><td class="rank">${r.position}</td><td>${r.team}</td><td>${r.played}</td><td>${r.gd > 0 ? "+" : ""}${r.gd}</td><td><strong>${r.points}</strong></td></tr>`).join("")
        + `</tbody></table></div>`;
  }
  if (sEl) {
    const scorers = (standings && standings.topScorers) || [];
    sEl.innerHTML = scorers.length === 0
      ? `<p class="empty">Top scorers not available yet.</p>`
      : `<div class="table-scroll"><table><thead><tr><th>Player</th><th>Team</th><th>Goals</th><th>Assists</th></tr></thead><tbody>`
        + scorers.map(s => `<tr><td>${s.name}</td><td>${s.team}</td><td><strong>${s.goals}</strong></td><td>${s.assists}</td></tr>`).join("")
        + `</tbody></table></div>`;
  }
}
