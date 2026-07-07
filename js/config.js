// ---------------------------------------------------------------------------
// Firebase + game configuration. Everything here is static, editable config —
// no logic, no DOM. See SETUP.md for what to change when forking.
// ---------------------------------------------------------------------------

// 1. PASTE YOUR FIREBASE CONFIG HERE (see SETUP.md)
export const firebaseConfig = {
  apiKey: "AIzaSyDT4p-B4V4veqPteUC8uxjrGBJcea2FgVA",
  authDomain: "pl-predictions-sv.firebaseapp.com",
  projectId: "pl-predictions-sv",
  storageBucket: "pl-predictions-sv.firebasestorage.app",
  appId: "1:610117601524:web:1919f552a6d91e20acb6a1",
  messagingSenderId: "610117601524",
  measurementId: "G-W0ZBJHPJ7F"
};

// 2. GAME CONFIG — edit these to match your rules
export const UNLOCK_GAMEWEEK = 20;      // teams become repickable from this gameweek
export const UNIQUE_THRESHOLD = 1;      // "picked by <= this many people" gets the bonus. Use 2 for "no one else, or 1 other"
export const BONUS_MULTIPLIER = 2;
export const WIN_POINTS = 1;

// Chips: at most one per week, and each chip can be played once per
// half-season (the two halves split at the GW20 reshuffle). Chip
// effects STACK with the unique-pick bonus above.
//   double       -> doubles the week's win points
//   doublechance -> a draw scores the same as a win this week (your team
//                   only needs to avoid defeat)
//   goalfest     -> if your team wins, you score the goals it scored that
//                   fixture instead of the flat win point (falls back to a
//                   normal win if goals aren't known)
//   scorecard    -> predict the exact scoreline; nail it for a flat bonus,
//                   regardless of whether the team won
export const SCORECARD_BONUS = 5;
export const CHIPS = {
  double:       { label: "Double Down",   desc: "Doubles the points you score this week. Stacks on top of the unique-pick bonus." },
  doublechance: { label: "Double Chance", desc: "Your team only needs to avoid defeat — a draw scores the same as a win this week (both fixtures in a double gameweek)." },
  goalfest:     { label: "Goalfest",      desc: "If your team wins, you score the number of goals it scored that match instead of the flat 1 point (goals from both fixtures in a double gameweek)." },
  scorecard:    { label: "Scorecard",     desc: `Predict your team's exact scoreline. Nail it for a flat +${SCORECARD_BONUS} — even on a draw or loss. Judged on the first fixture in a double gameweek.` },
};
export const halfOf = gw => (gw < UNLOCK_GAMEWEEK ? 1 : 2);

// Must exactly match the email in the isAdmin() function in firestore.rules
export const ADMIN_EMAIL = "sam.vinall@hotmail.co.uk";

export const TEAMS = [
  "Arsenal","Aston Villa","Bournemouth","Brentford","Brighton","Chelsea",
  "Coventry City","Crystal Palace","Everton","Fulham","Hull City",
  "Ipswich Town","Leeds United","Liverpool","Manchester City",
  "Manchester United","Newcastle United","Nottingham Forest",
  "Sunderland","Tottenham Hotspur"
];
