# Plan — Multipick chip

**Status:** planned, not started. Front-end + a new stored pick field; no new
collections and no security-rule change.

## What it does

A chip (so: one per week, once per half-season, hidden until the deadline like
any pick). When played, you pick **two** teams that week instead of one:

- If **either** team wins, you score a **flat win point** (a safety net —
  winning with both still scores just the one point, not two).
- The **unique-pick bonus applies if the winning team is unique** (picked by
  ≤ `UNIQUE_THRESHOLD` players) → the point doubles, as usual. If both win, the
  bonus applies if *either* winning team is unique.
- **Both teams are used up** — both grey out for the no-repeat rule (until the
  GW20 reshuffle), so the cost of the safety net is burning two of your teams.

### Decisions (from Q&A)
- Both teams winning → still the flat win point (not doubled). ✅
- Unique bonus → yes, judged on the **winning** team(s). ✅

## Scoring

For a multipick pick in gameweek `gw` with teams `A`, `B`:

- `won = [A, B].filter(t => results[gw_t] includes "win")`
- `base = won.length >= 1 ? WIN_POINTS : 0`  *(capped at one point — flat)*
- `isUnique = won.some(t => popularity[gw_t] <= UNIQUE_THRESHOLD)`
- `bonusPts = (base > 0 && isUnique) ? base * (BONUS_MULTIPLIER - 1) : 0`
- `pts = base + bonusPts`
- `chipPts = base` — the flat win point is attributed to the chip (the win came
  from playing Multipick), so it shows in the **Chip pts** column as well as the
  **Chips played** count. `bonusPts` still holds the unique doubling. So a
  multipick win breaks down as chip pts = 1 (+ bonus pts = 1 if the winning team
  was unique); the non-chip "raw" portion is 0.
- `won`/`played`: counts as won/played if at least one team produced a real
  result / win (consistent with the per-pick rule).

Because scoring now needs **two** teams' results, `scorePick()` (which takes a
single team's outcomes) can't handle multipick alone. Add a small shared
`scoreMultipick(pick, results, popularity)` used by **both** the leaderboard
and history (same "shared scoring so they never disagree" principle), and
branch to it when `pick.chip === "multipick"`.

### Double gameweeks & forfeits
- **Double GW:** still capped at the flat point (safety chip), regardless of
  how many wins across the two teams.
- **Forfeit:** each team frees independently if its fixture didn't happen (as
  today). If **both** teams forfeited, the week is a forfeit → per the UX-fixes
  rule the chip isn't counted or consumed. If one played, it's a real week.

## Data model

- Pick docs currently hold a single `team`. Add an optional **`team2`** used
  only when `chip === "multipick"` (less invasive than converting every
  `pick.team` reference to an array). So a multipick pick is
  `{ ..., chip: "multipick", team, team2 }`.
- No new collection; no security-rule change (rules validate uid / gameweek /
  deadline, not team fields).

## Used-teams

`myTeamsUsedSinceUnlock` must include **both** `team` and `team2` for multipick
weeks (each still freed individually if that team forfeited).

## Popularity knock-on

Both of a multipick player's teams count toward those teams' popularity for
*everyone's* unique-bonus calc (they did back both). Default: yes, both count.
*(Flag: this lets a multipick slightly dilute two teams' uniqueness for others
— accepted as fair since they genuinely picked both.)*

## UI (`js/render.js` pick panel / chip row)

- Selecting the **Multipick** chip reveals a **second-team selector** (like
  Scorecard reveals its score form) — a dropdown of currently-available teams
  excluding your first pick and any used teams. Both chosen teams show as
  selected in the grid.
- Submit stores `team` + `team2`. In later weeks both grey out ("used").
- Hidden-until-lock: both teams live on the one pick doc, so they're hidden
  together by the existing rules.
- Sheet + history + chip tag show **both** teams (e.g. "Multipick: A + B").
- Keeps the one-chip-per-week model — multipick doesn't stack with
  double/goalfest/etc.

## Config (`js/config.js`)

- Add to `CHIPS`:
  `multipick: { label: "Multipick", desc: "Pick two teams this week; if either
  wins you score the win (unique bonus applies if the winning team is unique).
  Both teams are then used up." }`
- Add a 5th chip-tag colour: a new CSS var + `.chip-multipick` in `styles.css`.

## Sequencing

1. `config.js`: add the chip + colour.
2. `scoreMultipick()` + branch in leaderboard/history scoring.
3. Pick UI: second-team selector, both-selected highlighting, store `team2`.
4. Used-teams: include `team2`.
5. Display: sheet / history / chip tag show both teams.
6. Docs: add to house rules in `docs/SETUP.md`.

## Verification

- Extend the node scoring check with multipick cases: one-wins, both-win
  (flat), winning-team-unique (doubles), both-lose (0), one-forfeit.
- Headless-Chrome smoke as usual.
- Manual: play multipick, confirm both teams grey out next week, confirm the
  table scores a single point (doubled only if the winning team was unique).

## Open questions

- Second team entry: dropdown vs. click-two-in-the-grid? (Default: reveal a
  dropdown, consistent with the Scorecard form pattern.)
