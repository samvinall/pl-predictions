// ---------------------------------------------------------------------------
// Shared, mutable app state. Modules read and write properties on this single
// object rather than passing everything around or juggling module-scoped
// `let`s — this is what lets the view/admin code stay decoupled from the
// controller. `reload` is wired up to loadEverything() in app.js; view code
// calls store.reload() to refresh after a write instead of importing the
// controller (which would create an import cycle).
// ---------------------------------------------------------------------------
export const store = {
  currentUser: null,
  currentConfig: null,   // { gameweek, deadline }
  myPicks: [],           // all of my picks, any gameweek (for chip usage)
  countdownTimer: null,
  // Staged ("draft") pick for the week shown in the Gameweeks tab:
  // { gw, team, chip, scorecard, team2 }. Edits live here and only hit
  // Firestore on Save; switching week re-inits it (silently discarding), and
  // nothing is reserved on other weeks until a draft is actually saved.
  draft: null,
  myPlayedGws: new Set(),  // gameweeks where my pick actually played (real result)
  names: {},               // uid -> chosen display name (from profiles/{uid})
  selectTab: null,         // set by initTabs(); selectTab(id) switches tab
  showingDenied: false,    // are we showing the "not on the guest list" screen?
  reload: async () => {},  // set to loadEverything() during boot

  // Admin "Time Machine": a client-only offset (ms) added to the real clock so
  // the admin can simulate a different "now" and see how the Gameweeks tab
  // renders across past/current/future weeks. Purely local -- never touches
  // data, and can't move the SERVER clock the pick-save rules use. Persisted in
  // localStorage so it survives reloads. See nowMs()/nowDate() below.
  clockOffsetMs: (() => {
    try { return parseInt(localStorage.getItem("simClockOffsetMs") || "0", 10) || 0; }
    catch (e) { return 0; }
  })(),

  // --- Whole-season calendar + the combined Gameweeks tab ---
  // schedule: sorted [{ gameweek, deadline: Date|null, fixtures: [...] }] mirrored
  // from config/schedule; lets the Gameweeks tab scroll through every week and
  // pre-pick future ones. selectedGameweek is the week that tab is showing.
  schedule: [],
  deadlinesByGw: {},       // gameweek(number) -> Date (from config/schedule)
  selectedGameweek: null,
  // Datasets cached from the last load so switching weeks in the Gameweeks tab
  // re-renders instantly without another Firestore read.
  allPicks: [],
  results: {},
  goalsByKey: {},
  concededByKey: {},
  popularity: {},
};

// The app's notion of "now", including the admin Time Machine offset. All
// gameweek open/locked/current rendering reads through these so simulating a
// different date is a one-line change everywhere. NB: this is client-only --
// Firestore security rules still enforce against the real server clock.
export const nowMs = () => Date.now() + (store.clockOffsetMs || 0);
export const nowDate = () => new Date(nowMs());
