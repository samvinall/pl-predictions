// ---------------------------------------------------------------------------
// Controller / composition root. Wires auth to the UI, loads everything from
// Firestore, and boots the app. This is the only module that ties the others
// together; the rest stay focused and talk through `store`.
// ---------------------------------------------------------------------------
import {
  auth, db, provider,
  signInWithPopup, signOut, onAuthStateChanged,
  doc, getDoc, collection, query, where, getDocs,
} from "./firebase.js";
import { ADMIN_EMAIL } from "./config.js";
import { store, nowDate } from "./store.js";
import { multipickOutcomes } from "./scoring.js";
import { setupAdminPanel, setupAccessPanel, renderAdminRecent, renderAdminNames, setupSeasonAdmin, loadAllowlist, setupTimeMachine } from "./admin.js";
import {
  startDeadlineCountdown, renderWeek, currentGameweek,
  renderLeaderboard, computeWeeklyTotals, computeSeasonPoints,
  renderProfile, renderRules,
} from "./render.js";
import { renderSeason } from "./season.js";
import { initTabs } from "./tabs.js";

// View/admin code refreshes by calling store.reload() so it never has to
// import this controller (which would be a cycle).
store.reload = loadEverything;

// One-time UI setup (the tab bar + the static Rules content).
initTabs();
renderRules();

// --- Sign-in / sign-out / denial gate wiring --------------------------------
document.getElementById("signin-btn").onclick = () => signInWithPopup(auth, provider).catch(e => alert(e.message));
document.getElementById("signout-btn").onclick = () => signOut(auth);
document.getElementById("denied-retry").onclick = () => {
  store.showingDenied = false;
  document.getElementById("denied-gate").style.display = "none";
  document.getElementById("signin-gate").style.display = "block";
};

// Read the guest list (config/allowlist) and decide whether this account
// is allowed in. The admin is always allowed. Matching is case-insensitive.
// The real enforcement lives in firestore.rules; this just controls the UI
// and signs unwanted accounts straight back out.
async function isEmailAllowed(email) {
  const e = (email || "").toLowerCase();
  if (e === ADMIN_EMAIL.toLowerCase()) return true;
  try {
    const snap = await getDoc(doc(db, "config", "allowlist"));
    const emails = (snap.exists() && snap.data().emails) || [];
    return emails.some(a => (a || "").toLowerCase() === e);
  } catch (err) {
    // Fail closed: if we can't read the list, don't let anyone in.
    return false;
  }
}

onAuthStateChanged(auth, async (user) => {
  store.currentUser = user;
  if (user) {
    if (!(await isEmailAllowed(user.email))) {
      // Turned away at the door: show the denial screen and sign out. The
      // sign-out fires this handler again with user=null; showingDenied
      // keeps the denial screen up rather than falling back to sign-in.
      store.showingDenied = true;
      store.currentUser = null;
      document.getElementById("denied-email").textContent = user.email;
      document.getElementById("signin-gate").style.display = "none";
      document.getElementById("app").style.display = "none";
      document.getElementById("denied-gate").style.display = "block";
      await signOut(auth);
      return;
    }
    store.showingDenied = false;
    document.getElementById("denied-gate").style.display = "none";
    document.getElementById("signin-gate").style.display = "none";
    document.getElementById("app").style.display = "block";
    document.getElementById("whoami").textContent = `Signed in as ${user.displayName} (${user.email})`;

    if (user.email === ADMIN_EMAIL) {
      document.getElementById("tab-btn-admin").style.display = "";
      setupAdminPanel();
      setupAccessPanel();
      setupTimeMachine();
    }

    await loadEverything();
  } else {
    document.getElementById("app").style.display = "none";
    // Don't clobber the denial screen with the sign-in gate when the
    // sign-out was triggered by us turning an unlisted account away.
    if (!store.showingDenied) {
      document.getElementById("denied-gate").style.display = "none";
      document.getElementById("signin-gate").style.display = "block";
    }
  }
});

async function loadEverything() {
  const configSnap = await getDoc(doc(db, "config", "current"));
  if (!configSnap.exists()) {
    document.getElementById("pick-status").textContent = "No gameweek open yet — check back once the admin sets one.";
    return;
  }
  store.currentConfig = configSnap.data(); // { gameweek: number, deadline: Timestamp }
  const deadlineDate = store.currentConfig.deadline.toDate();
  const now = new Date();
  const isOpen = now < deadlineDate;

  document.getElementById("gw-badge").textContent = `GW ${store.currentConfig.gameweek}`;
  startDeadlineCountdown(deadlineDate, isOpen);

  // Fetch picks in a way that satisfies the security rules (see
  // firestore.rules): your own picks (any gameweek), everyone's picks
  // from already-played gameweeks, and -- only once this gameweek's
  // deadline has passed -- everyone's picks for the current gameweek.
  // Before the deadline, rivals' current picks are never sent to the
  // browser at all, so they can't be dug out of the network tab.
  const picksCol = collection(db, "picks");
  const picksQueries = [
    getDocs(query(picksCol, where("uid", "==", store.currentUser.uid))),
    getDocs(query(picksCol, where("gameweek", "<", store.currentConfig.gameweek))),
  ];
  if (!isOpen) {
    picksQueries.push(getDocs(query(picksCol, where("gameweek", "==", store.currentConfig.gameweek))));
  }
  const picksById = new Map();
  (await Promise.all(picksQueries)).forEach(
    snap => snap.docs.forEach(d => picksById.set(d.id, d.data()))
  );
  // Only ever surface data for people currently on the guest list (plus
  // the admin). Anyone removed from the list -- or whose old picks linger
  // -- drops out of the sheet, leaderboard, history and the unique-pick
  // counts, so the tables always reflect just the current players.
  const allowedEmails = new Set([ADMIN_EMAIL.toLowerCase(), ...(await loadAllowlist())]);
  const allPicks = Array.from(picksById.values())
    .filter(p => allowedEmails.has((p.email || "").toLowerCase()));

  // Resolve chosen display names (profiles/{uid}) -> store.names, used
  // wherever a player's name is shown (sheet, table, history, whoami).
  store.names = {};
  try {
    const profilesSnap = await getDocs(collection(db, "profiles"));
    profilesSnap.docs.forEach(d => { const pr = d.data(); if (pr && pr.name) store.names[d.id] = pr.name; });
  } catch (e) { /* names are optional */ }
  document.getElementById("whoami").textContent =
    `Signed in as ${store.names[store.currentUser.uid] || store.currentUser.displayName} (${store.currentUser.email})`;

  const resultsSnap = await getDocs(collection(db, "results"));
  const results = {};        // key -> array of outcomes, e.g. ["win"] or ["win","loss"]
  const goalsByKey = {};     // key -> array of goals scored by the team, aligned to results
  const concededByKey = {};  // key -> array of goals conceded by the team, aligned to results
  const resultsDocs = [];
  resultsSnap.docs.forEach(d => {
    const r = d.data();
    const key = `${r.gameweek}_${r.team}`;
    results[key] = r.results || [];
    goalsByKey[key] = r.goals || [];
    concededByKey[key] = r.conceded || [];
    resultsDocs.push(r);
  });
  if (store.currentUser.email === ADMIN_EMAIL) {
    renderAdminRecent(resultsDocs);
    // Players the admin can rename: everyone who's picked, plus anyone with a
    // profile already set.
    const byUid = new Map();
    allPicks.forEach(p => { if (!byUid.has(p.uid)) byUid.set(p.uid, { uid: p.uid, email: p.email, name: store.names[p.uid] || p.name }); });
    Object.keys(store.names).forEach(uid => { if (!byUid.has(uid)) byUid.set(uid, { uid, email: "", name: store.names[uid] }); });
    renderAdminNames([...byUid.values()]);
  }

  store.myPicks = allPicks.filter(p => p.uid === store.currentUser.uid);
  // The teams a pick occupies: two for a Multipick, otherwise one.
  const teamsOf = p => (p.chip === "multipick" && p.team2 ? [p.team, p.team2] : [p.team]);

  // Gameweeks where my pick actually played (a real win/draw/loss for at least
  // one of its teams). Used to decide which chips have been "spent" this half
  // -- a chip on a forfeited/unplayed week doesn't count and stays re-playable.
  store.myPlayedGws = new Set();
  store.myPicks.forEach(p => {
    const outs = p.chip === "multipick"
      ? multipickOutcomes(p.gameweek, p.team, p.team2, results)
      : (results[`${p.gameweek}_${p.team}`] || []);
    if (outs.some(o => o === "win" || o === "draw" || o === "loss")) store.myPlayedGws.add(p.gameweek);
  });

  // How many people picked each team that week -- drives the unique-pick
  // bonus. Computed once here and shared by the leaderboard and history.
  // A Multipick backs both of its teams, so both count toward popularity.
  const popularity = {};
  allPicks.forEach(p => {
    teamsOf(p).forEach(t => {
      const key = `${p.gameweek}_${t}`;
      popularity[key] = (popularity[key] || 0) + 1;
    });
  });

  // ---- Season predictions (GW0) ----
  const seasonCfg = (await getDoc(doc(db, "config", "season"))).data() || null;
  const seasonDeadlineTs = seasonCfg && seasonCfg.predictionsDeadline;
  const seasonDeadline = seasonDeadlineTs && seasonDeadlineTs.toDate ? seasonDeadlineTs.toDate() : null;
  // Two notions of "open": the REAL one gates what we're allowed to read (must
  // match the rules, which use the server clock); the SIMULATED one (Time
  // Machine) only drives how the Season tab renders.
  const seasonOpenReal = !seasonDeadline || new Date() < seasonDeadline;
  const seasonOpenSim = !seasonDeadline || nowDate() < seasonDeadline;
  const seasonResults = (await getDoc(doc(db, "config", "season_results"))).data() || null;
  const standings = (await getDoc(doc(db, "config", "standings"))).data() || null;

  // Player list powers the Golden Boot picker (while open) and the admin's
  // result picker (any time), so load it if predictions are open or you're admin.
  let players = null;
  if (seasonOpenReal || store.currentUser.email === ADMIN_EMAIL) {
    const playersData = (await getDoc(doc(db, "config", "players"))).data();
    players = playersData ? (playersData.players || []) : null;
  }

  // Own season pick always readable; everyone's once the deadline really passes.
  let seasonPicks = [];
  if (seasonOpenReal) {
    const mine = (await getDoc(doc(db, "season_picks", store.currentUser.uid))).data();
    if (mine) seasonPicks = [mine];
  } else {
    const all = await getDocs(collection(db, "season_picks"));
    seasonPicks = all.docs.map(d => d.data()).filter(sp => allowedEmails.has((sp.email || "").toLowerCase()));
  }
  const mySeasonPick = seasonPicks.find(sp => sp.uid === store.currentUser.uid) || null;

  if (store.currentUser.email === ADMIN_EMAIL) setupSeasonAdmin(players, seasonCfg, seasonResults);

  // Whole-season calendar: per-gameweek deadlines + fixtures, mirrored into
  // config/schedule by advance_gameweek.py. Drives the Gameweeks tab's week
  // navigator and future-week pre-picking. Falls back to just the current
  // gameweek if the schedule hasn't been synced yet.
  let scheduleData = null;
  try {
    const schedSnap = await getDoc(doc(db, "config", "schedule"));
    if (schedSnap.exists()) scheduleData = schedSnap.data();
  } catch (e) { /* fall back to current-only below */ }
  buildSchedule(scheduleData);

  // Keep the datasets around so switching weeks in the Gameweeks tab can
  // re-render instantly without another Firestore read.
  store.allPicks = allPicks;
  store.results = results;
  store.goalsByKey = goalsByKey;
  store.concededByKey = concededByKey;
  store.popularity = popularity;

  // Default the Gameweeks tab to the (possibly simulated) current week; keep
  // the player's chosen week across a reload if it's still on the calendar.
  const validGws = store.schedule.map(s => s.gameweek);
  if (store.selectedGameweek == null || !validGws.includes(store.selectedGameweek)) {
    const cur = currentGameweek();
    store.selectedGameweek = (cur != null && validGws.includes(cur)) ? cur : store.currentConfig.gameweek;
  }

  // Time Machine indicator: a persistent reminder while a simulated clock is on.
  const simEl = document.getElementById("sim-indicator");
  if (simEl) {
    if (store.clockOffsetMs) { simEl.style.display = ""; simEl.textContent = `🕓 SIM ${nowDate().toLocaleString()}`; }
    else simEl.style.display = "none";
  }

  // End-of-season Final Table: weekly points + season-prediction points, only
  // once the admin has published the answers (config/season_results). Kept out
  // of the live weekly table so mid-season standings never include predictions.
  let finalTable = null;
  if (seasonResults && (seasonResults.goldenBootId != null || seasonResults.champion)) {
    const weekly = computeWeeklyTotals(allPicks, results, goalsByKey, concededByKey, popularity);
    const season = computeSeasonPoints(seasonPicks, seasonResults);
    const nameByEmail = {};
    seasonPicks.forEach(sp => { nameByEmail[sp.email] = store.names[sp.uid] || sp.name || sp.email; });
    Object.entries(weekly).forEach(([email, t]) => { nameByEmail[email] = t.name || nameByEmail[email] || email; });
    finalTable = [...new Set([...Object.keys(weekly), ...Object.keys(season)])].map(email => {
      const w = weekly[email] ? weekly[email].points : 0;
      const s = season[email] || 0;
      return { email, name: nameByEmail[email] || email, weekly: w, season: s, total: w + s };
    }).sort((a, b) => b.total - a.total || b.weekly - a.weekly);
  }

  renderProfile();
  renderWeek();
  renderSeason({ open: seasonOpenSim, deadline: seasonDeadline, results: seasonResults, standings, players, seasonPicks, myPick: mySeasonPick, finalTable });
  renderLeaderboard(allPicks, results, goalsByKey, concededByKey, popularity);
}

// Turn the mirrored config/schedule doc into store.schedule (a sorted list of
// { gameweek, deadline: Date|null, fixtures }) + store.deadlinesByGw. If the
// schedule isn't published yet, synthesise a single entry for the current
// gameweek so the Gameweeks tab still works.
function buildSchedule(scheduleData) {
  store.schedule = [];
  store.deadlinesByGw = {};
  const deadlines = (scheduleData && scheduleData.deadlines) || {};
  const fixturesByGw = (scheduleData && scheduleData.fixturesByGw) || {};
  const gws = new Set(
    [...Object.keys(deadlines), ...Object.keys(fixturesByGw)].map(k => parseInt(k, 10))
  );
  gws.forEach(gw => {
    const ts = deadlines[String(gw)];
    const deadline = ts && ts.toDate ? ts.toDate() : null;
    if (deadline) store.deadlinesByGw[gw] = deadline;
    store.schedule.push({ gameweek: gw, deadline, fixtures: fixturesByGw[String(gw)] || [] });
  });
  // Fallback: no schedule synced yet -> at least offer the current gameweek.
  const cur = store.currentConfig.gameweek;
  if (!store.schedule.some(s => s.gameweek === cur)) {
    const deadline = store.currentConfig.deadline.toDate();
    store.deadlinesByGw[cur] = deadline;
    store.schedule.push({ gameweek: cur, deadline, fixtures: [] });
  }
  store.schedule.sort((a, b) => a.gameweek - b.gameweek);
}
