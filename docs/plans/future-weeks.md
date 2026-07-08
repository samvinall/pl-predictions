# Future-week selection + Settings tab

## Why

Two TODO items:

1. **Name selection should live somewhere everyone can reach it.** The
   self-service display-name editor was on the old "This Week" tab, which this
   change removes.
2. **Let players pick for future gameweeks**, not just the live one — look ahead
   at fixtures and lock in a team early.

## What changed

- **Combined "Gameweeks" tab.** "Pick", "This Week" and "History" are now one tab
  with a week navigator (`‹` / dropdown / `›`). For the selected week it shows the
  fixtures, a status line (live / upcoming / locked), and either the pick UI
  (open weeks) or the full results table (locked weeks — which doubles as the
  reveal sheet).
- **Pre-picking.** Any week still before its own deadline is pickable, current or
  future. Picks and chips are written for the selected gameweek. A team picked
  for a future week is **reserved immediately** — locked out of every other week
  in the same half-season (no-repeat resets at the GW20 reshuffle).
- **Settings tab** (visible to all): the display-name editor. Admin name
  overrides stay on the Admin tab.

## How it works

- `advance_gameweek.py` mirrors the whole-season calendar into **`config/schedule`**:
  `{ deadlines: { "<gw>": Timestamp }, fixturesByGw: { "<gw>": [rows] }, updated }`.
  `deadlines` is a map keyed by gameweek string so the security rules can index
  straight into it. Pure helpers `build_fixture_rows` and `build_schedule` are
  unit-tested in `test/test_advance_gameweek.py`.
- **`firestore.rules`** — a pick create/update is allowed only while
  `request.time < config/schedule.deadlines[string(gameweek)]` (past weeks and
  unknown gameweeks are refused). The read rule was tightened so locking the
  current week no longer exposes *future* picks — a week's picks become readable
  exactly when it is current-and-locked.
- **Client** (`js/app.js`, `js/render.js`, `js/store.js`): `loadEverything` builds
  `store.schedule` + `store.deadlinesByGw` from `config/schedule` (falling back to
  the current gameweek if the schedule hasn't synced yet) and caches the picks /
  results datasets so the navigator re-renders instantly. `renderWeek()` is the
  orchestrator; `submitPick` / `setChip` take a target gameweek; `teamsUsedForWeek`
  implements the reserve-immediately no-repeat rule.

## Verify

- `python3 -m unittest discover -s test -p 'test_*.py'` — all green.
- Serve locally, sign in: navigator scrolls past→current→future; a future week
  shows fixtures + a pickable grid; picking reserves the team elsewhere; locked
  weeks show results; Settings saves a display name; This Week / History tabs gone.
