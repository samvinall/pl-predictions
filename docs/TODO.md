# Features

_(nothing outstanding)_

# Done

- ✅ Future-week selection — "Pick", "This Week" and "History" collapsed into one **Gameweeks** tab with a week navigator (‹ / dropdown / ›). Each week shows its own fixtures, status and (once locked) results; any week still before its deadline is pickable, so you can pre-pick ahead. A team picked for a future week is reserved immediately (no-repeat is per half-season). Per-week deadlines + fixtures are mirrored into `config/schedule`, and firestore.rules locks each pick at that week's real kickoff. ([plan](plans/future-weeks.md))
- ✅ Display name moved to a **Settings** tab visible to all users (was on the old "This Week" tab). Admin name overrides stay in the Admin tab.
- ✅ GW0 season-long predictions — "Season" tab: Golden Boot (FPL autocomplete, 10 pts, ×2 if unique) + champion (5 pts, ×2 if unique), lock at transfer-window close (admin-set), loud-then-quiet nudge, live PL top 4 + top scorers/assists, admin resolution, season bonuses on the league table. ([plan](plans/gw0-predictions.md))
- ✅ Custom display names — self-service on This Week + admin override. ([plan](plans/display-names.md))
- ✅ More info on the picker page — sign-in gate + Pick card now say "pick one team you think will win their match", how scoring works, and the no-repeat rule. (Fixtures for the gameweek you're picking are already on the Pick tab.)
- ✅ Gameweek History shows the actual scoreline of each picked team's match (per-team for Multipick).
- ✅ "This Week" tab — your current pick + each team's match info (opponent, kickoff / live score) + this week's gamesheet, all in one place.
- ✅ Multipick chip — pick 2 teams; flat win point if either wins (unique bonus if the winning team is unique); both teams get used up. ([plan](plans/multipick-chip.md))
- ✅ UX fixes — layout is now tabs (Pick · Table · History · Rules · Admin), Rules tab, fixtures on the Pick tab, league table counts only scored picks, forfeited-week chips don't count/consume. ([plan](plans/ux-fixes.md))
