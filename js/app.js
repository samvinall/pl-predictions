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
import { setupAdminPanel, setupAccessPanel, renderAdminRecent, loadAllowlist } from "./admin.js";
import {
  startDeadlineCountdown, renderPickPanel, renderSheet,
  renderLeaderboard, renderHistory, renderFixtures,
} from "./render.js";

// View/admin code refreshes by calling store.reload() so it never has to
// import this controller (which would be a cycle).
store.reload = loadEverything;

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
      document.getElementById("admin-card").style.display = "block";
      document.getElementById("admin-access-card").style.display = "block";
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
  if (store.currentUser.email === ADMIN_EMAIL) renderAdminRecent(resultsDocs);

  store.myPicks = allPicks.filter(p => p.uid === store.currentUser.uid);
  // A team only stays "used" if the pick actually resolved to a real
  // match (win/draw/loss). If it came back as a forfeit (the picked
  // team didn't end up playing that gameweek), the team is freed up
  // again immediately rather than being wasted.
  const myTeamsUsedSinceUnlock = new Set(
    store.myPicks
      .filter(p => p.gameweek < UNLOCK_GAMEWEEK && !(results[`${p.gameweek}_${p.team}`] || []).includes("forfeit"))
      .map(p => p.team)
  );
  store.myPickThisWeek = store.myPicks.find(p => p.gameweek === store.currentConfig.gameweek) || null;

  // How many people picked each team that week -- drives the unique-pick
  // bonus. Computed once here and shared by the leaderboard and history.
  const popularity = {};
  allPicks.forEach(p => {
    const key = `${p.gameweek}_${p.team}`;
    popularity[key] = (popularity[key] || 0) + 1;
  });

  renderPickPanel(isOpen, myTeamsUsedSinceUnlock);
  renderSheet(allPicks.filter(p => p.gameweek === store.currentConfig.gameweek), isOpen);
  renderLeaderboard(allPicks, results, goalsByKey, concededByKey, popularity);
  renderHistory(allPicks, results, goalsByKey, concededByKey, isOpen, popularity);
  renderFixtures();
}
