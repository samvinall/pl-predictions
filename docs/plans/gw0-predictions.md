# Plan — Gameweek 0 season-long predictions

**Status:** planned, not started.

One-off, season-long predictions made *before* GW1 and scored at season end.
Golden Boot is the confirmed feature; a Premier League winner pick is noted as
a potential add-on.

## Scope & decisions

### Golden Boot winner — confirmed
- **Input:** FPL-backed autocomplete. Mirror the FPL player list into
  Firestore (same pattern as `config/fixtures`) and drive a type-to-search
  `<input>` + `<datalist>`, storing the player's **FPL element id** plus a
  display name. Canonical names, exact-match resolution, no manual judging.
- **Points:** **10** for a correct pick (one config constant).

### Premier League winner — potential (not confirmed)
- Pick one of the 20 `TEAMS` from a simple dropdown — trivial vs the Golden
  Boot. Suggested value ~5 pts if added. Same lock/reveal/resolve mechanics.
- **Unique bonus:** if you're the *only* player who correctly picked the
  champion, **double** the points (mirrors the weekly unique-pick bonus). So
  base 5 → 10 if you nailed it alone. Uniqueness is judged over correct picks
  (everyone who picked the actual winner); if just one person did, they get the
  double.
- Left as an option; decide before building. *(Open: should the same
  unique-doubling apply to the Golden Boot? Currently only specified for the
  PL winner.)*

### Shared mechanics
- **Lock:** both predictions lock at the **GW1 deadline** (kickoff of the
  first match); freely changeable until then, frozen after.
- **Visibility:** hidden from other players until locked, then revealed —
  consistent with weekly picks and **enforced in `firestore.rules`**, not just
  the UI.
- **Resolution:** admin sets the correct answer(s) at season end; matching
  users get the bonus added to the league table.

## Data model

- `config/players` *(new, mirrored by `advance_gameweek.py`)* —
  `{ players: [ { id, name, team, position } ], updated }`. Include all
  outfield players (autocomplete handles the volume; don't risk excluding a
  dark-horse). Written server-side by the sync (Admin SDK bypasses rules).
- `season_picks/{uid}` *(new)* — one doc per user:
  `{ uid, name, email, goldenBootId, goldenBootName, champion?, updated }`.
- `config/season` *(new)* — `{ predictionsDeadline: <GW1 kickoff ts> }`, set by
  the sync when GW1 is first seen (weekly picks use `config/current.deadline`,
  which advances past GW1, so season lock needs its own stored timestamp).
- `config/season_results` *(new, admin-written)* —
  `{ goldenBootId, goldenBootName, champion }` (the correct answers).
- `js/config.js` constants: `GOLDEN_BOOT_BONUS = 10` (and `CHAMPION_BONUS = 5`
  if the PL-winner pick is added).

## Firestore rules

- `config/players`, `config/season`: read for allow-listed users; no client
  write (sync writes via Admin SDK).
- `config/season_results`: read for allow-listed; write admin only.
- `season_picks/{uid}`:
  - read: own doc always; others only once `request.time >=
    config/season.predictionsDeadline` (hidden-until-lock, mirroring the picks
    rule).
  - create/update: own `uid` only, and only before `predictionsDeadline`.
  - delete: false.

## Python (`advance_gameweek.py`)

- Mirror FPL `elements` → `config/players` (id, `web_name`, team, position),
  alongside the existing fixtures mirror.
- Set `config/season.predictionsDeadline` to the GW1 deadline when detected.
- Existing stale-season guard already protects this.

## Front-end

- New card **"Season Predictions (GW0)"** (likely a small `js/season.js`
  module, or folded into `render.js`):
  - Golden Boot: `<input>` + `<datalist>` from `config/players`; save; the
    same locked/hidden states as the pick panel.
  - (Potential) Champion: `<select>` of `TEAMS`.
  - After lock, a small read-only sheet of everyone's season predictions.
- **Admin panel:** fields to set the correct Golden Boot (same autocomplete)
  and champion → writes `config/season_results`.
- **Leaderboard integration:** `loadEverything()` loads `season_picks` +
  `config/season_results`; `renderLeaderboard` adds `GOLDEN_BOOT_BONUS`
  (and `CHAMPION_BONUS`) to matching users' totals, shown with a tag/tooltip
  (e.g. `+10 GB`) so it's clear where the points came from. For the champion
  bonus, if exactly one player picked the actual winner, double their
  `CHAMPION_BONUS` (unique-pick bonus) — count correct champion picks across
  `season_picks` to decide.

## Nice-to-haves (later)

- **Auto-resolve** the Golden Boot from FPL top-scorer data at season end
  instead of manual admin entry (the pipeline already has the data).
- **Live "current Golden Boot leader"** display during the season.

## Rough sequencing

1. Python: mirror players + set season deadline.
2. Rules: `season_picks`, `config/season`, `config/season_results`.
3. `config.js` constants + season prediction UI + hidden/lock states.
4. Admin resolution UI.
5. Leaderboard scoring integration + display.
6. Docs: add to house rules in `docs/SETUP.md`.
