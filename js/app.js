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
import { ADMIN_EMAIL, UNLOCK_GAMEWEEK } from "./config.js";
import { store } from "./store.js";
import { multipickOutcomes } from "./scoring.js";
import { setupAdminPanel, setupAccessPanel, renderAdminRecent, renderAdminNames, setupSeasonAdmin, loadAllowlist } from "./admin.js";
import {
  startDeadlineCountdown, renderPickPanel, renderSheet,
  renderLeaderboard, renderHistory, renderFixtures, renderThisWeek,
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

  // Teams used in EARLIER weeks this half stay locked (no repeats until the
  // GW20 reshuffle). A team whose fixture was forfeited (didn't play) is freed
  // up again rather than wasted. The current week's own pick isn't "used".
  const myTeamsUsedSinceUnlock = new Set();
  store.myPicks.forEach(p => {
    if (p.gameweek >= store.currentConfig.gameweek || p.gameweek >= UNLOCK_GAMEWEEK) return;
    teamsOf(p).forEach(t => {
      if (!(results[`${p.gameweek}_${t}`] || []).includes("forfeit")) myTeamsUsedSinceUnlock.add(t);
    });
  });

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

  store.myPickThisWeek = store.myPicks.find(p => p.gameweek === store.currentConfig.gameweek) || null;

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
  const seasonOpen = !seasonDeadline || new Date() < seasonDeadline;
  const seasonResults = (await getDoc(doc(db, "config", "season_results"))).data() || null;
  const standings = (await getDoc(doc(db, "config", "standings"))).data() || null;

  // Player list powers the Golden Boot picker (while open) and the admin's
  // result picker (any time), so load it if predictions are open or you're admin.
  let players = null;
  if (seasonOpen || store.currentUser.email === ADMIN_EMAIL) {
    const playersData = (await getDoc(doc(db, "config", "players"))).data();
    players = playersData ? (playersData.players || []) : null;
  }

  // Own season pick always readable; everyone's once the deadline passes.
  let seasonPicks = [];
  if (seasonOpen) {
    const mine = (await getDoc(doc(db, "season_picks", store.currentUser.uid))).data();
    if (mine) seasonPicks = [mine];
  } else {
    const all = await getDocs(collection(db, "season_picks"));
    seasonPicks = all.docs.map(d => d.data()).filter(sp => allowedEmails.has((sp.email || "").toLowerCase()));
  }
  const mySeasonPick = seasonPicks.find(sp => sp.uid === store.currentUser.uid) || null;

  if (store.currentUser.email === ADMIN_EMAIL) setupSeasonAdmin(players, seasonCfg, seasonResults);

  // Fetch the mirrored fixtures once and share between the fixtures rail and
  // the "This Week" tab (both need this gameweek's fixtures + live scores).
  let fixturesData = null;
  try {
    const fxSnap = await getDoc(doc(db, "config", "fixtures"));
    if (fxSnap.exists()) fixturesData = fxSnap.data();
  } catch (e) { /* leave null -> "not published yet" */ }

  renderProfile();
  renderPickPanel(isOpen, myTeamsUsedSinceUnlock);
  renderThisWeek(fixturesData);
  renderSeason({ open: seasonOpen, deadline: seasonDeadline, results: seasonResults, standings, players, seasonPicks, myPick: mySeasonPick });
  renderSheet(allPicks.filter(p => p.gameweek === store.currentConfig.gameweek), isOpen);
  renderLeaderboard(allPicks, results, goalsByKey, concededByKey, popularity, seasonPicks, seasonResults);
  renderHistory(allPicks, results, goalsByKey, concededByKey, isOpen, popularity);
  renderFixtures(fixturesData);
}
