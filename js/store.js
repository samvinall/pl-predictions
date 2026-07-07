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
  myPickThisWeek: null,
  countdownTimer: null,
  scorecardEditing: false, // is the Scorecard score-entry form open?
  multipickEditing: false, // is the Multipick second-team form open?
  myPlayedGws: new Set(),  // gameweeks where my pick actually played (real result)
  names: {},               // uid -> chosen display name (from profiles/{uid})
  selectTab: null,         // set by initTabs(); selectTab(id) switches tab
  showingDenied: false,    // are we showing the "not on the guest list" screen?
  reload: async () => {},  // set to loadEverything() during boot
};
