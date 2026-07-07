// ---------------------------------------------------------------------------
// Pure scoring + formatting logic. No DOM, no Firebase — just functions of
// their inputs, so this module is unit-testable on its own (see test/).
// ---------------------------------------------------------------------------
import { WIN_POINTS, BONUS_MULTIPLIER, UNIQUE_THRESHOLD, SCORECARD_BONUS } from "./config.js";

// Shared scoring so the leaderboard and history never disagree. Takes
// one pick's outcomes, the goals the team scored and conceded (both
// aligned to outcomes), the chip played, its scorecard prediction (if
// any), and how many people picked that team that week (unique bonus).
// Returns { pts, bonus, bonusPts, chipPts, wins, scorecardHit }, where
// pts = raw win points + chipPts + bonusPts, so the leaderboard can show
// how much of a total came from chips vs. the unique-pick bonus.
export function scorePick(outcomes, goals, conceded, chip, scorecard, popCount) {
  outcomes = outcomes || [];
  // Fixtures that earn points this week. A win always does; Double Chance
  // also lets a draw earn the flat win points. `trueWins` stays a count of
  // actual wins only, so the "Won" column and form letters never treat a
  // Double Chance draw as a win.
  const scoringIdx = [];
  let trueWins = 0;
  outcomes.forEach((o, i) => {
    if (o === "win") { scoringIdx.push(i); trueWins++; }
    else if (o === "draw" && chip === "doublechance") { scoringIdx.push(i); }
  });

  // `raw` is what a plain no-chip pick scores (wins only). `base` is the
  // pre-unique-bonus score *including* the chip effect; base - raw is the
  // chip's contribution.
  const raw = trueWins * WIN_POINTS;
  let base;
  if (chip === "goalfest") {
    const g = Array.isArray(goals) && goals.length === outcomes.length ? goals : null;
    // Sum the goals scored in each winning fixture. If goals aren't
    // recorded, fall back to scoring it as an ordinary win.
    base = g ? scoringIdx.reduce((sum, i) => sum + (Number(g[i]) || 0), 0)
             : scoringIdx.length * WIN_POINTS;
  } else {
    base = scoringIdx.length * WIN_POINTS;
    if (chip === "double") base *= 2;
  }

  // The unique-pick bonus multiplies the whole (chip-adjusted) base, and
  // stacks with chips (chosen house rule). bonusPts is the extra it adds.
  const bonus = base > 0 && popCount <= UNIQUE_THRESHOLD;
  const bonusPts = bonus ? base * (BONUS_MULTIPLIER - 1) : 0;

  // Scorecard: a flat bonus for calling the exact scoreline of the
  // team's fixture -- independent of the result (you can nail a losing
  // scoreline) and NOT multiplied by the unique bonus. The prediction
  // is tied to the gameweek's first fixture (index 0); in a double
  // gameweek it must match that specific game, not whichever one fits.
  let scorecardHit = false, scorecardFlat = 0;
  if (chip === "scorecard" && scorecard
      && Array.isArray(goals) && goals.length === outcomes.length
      && Array.isArray(conceded) && conceded.length === outcomes.length
      && outcomes.length > 0) {
    scorecardHit =
      Number(goals[0]) === Number(scorecard.for) &&
      Number(conceded[0]) === Number(scorecard.against);
    if (scorecardHit) scorecardFlat = SCORECARD_BONUS;
  }

  const pts = base + bonusPts + scorecardFlat;
  // The Scorecard flat bonus is itself a chip effect, so it counts as chip
  // points alongside the double/goalfest/double-chance contribution.
  const chipPts = (base - raw) + scorecardFlat;
  return { pts, bonus, bonusPts, chipPts, wins: trueWins, scorecardHit };
}

export function fmtCountdown(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  return `${m}m ${sec}s`;
}

// Count how many of the most recent form entries (from the end) satisfy
// `pred` before it breaks -- used for win streaks (🔥) and cold runs (🧊).
export function trailingStreak(form, pred) {
  let n = 0;
  for (let i = form.length - 1; i >= 0; i--) {
    if (pred(form[i].letter)) n++;
    else break;
  }
  return n;
}
