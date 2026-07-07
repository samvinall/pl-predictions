# Prem Picks 26/27

A last-team-standing style Premier League prediction game for a group of
friends. Each week you back one team; back winners, dodge repeats, and play
your chips at the right moment to climb the table.

Runs as a single static site on **GitHub Pages**, backed by **Firebase**
(Google sign-in + Firestore) on the free tier, with results and gameweeks
synced automatically from the FPL API by **GitHub Actions**. No server to run.

## How the game works

- **One pick per gameweek.** Choose a team before the deadline (the kickoff of
  the gameweek's first match). Changeable any number of times until then.
- **No repeats until the reshuffle.** A team you've used is locked for the
  rest of the first half of the season; everything frees up again from
  **gameweek 20**.
- **Scoring.** A win scores 1 point. If you're the only one (`≤1` other) to
  back a team that week, the **unique-pick bonus** doubles your points.
- **Chips** — at most one per week, each usable once per half-season, and they
  stack with the unique-pick bonus:
  - **Double Down** — doubles the week's points.
  - **Double Chance** — a draw scores the same as a win.
  - **Goalfest** — if your team wins, score the goals it scored instead of the
    flat point.
  - **Scorecard** — predict the exact scoreline for a flat +5, even on a loss.
- **Picks are hidden** from everyone else until the gameweek locks — enforced
  by Firestore security rules, not just the UI.
- **Guest list.** Only allow-listed accounts can play; the admin manages the
  list from inside the app.

See [`docs/SETUP.md`](docs/SETUP.md) for the house rules in full (forfeits,
double gameweeks, postponements, etc.).

## Tech & architecture

- **Front end:** plain, buildless ES modules — the browser loads them straight
  from Pages, so deploying is just `git push`. No bundler, no build step.
- **Backend:** Firebase Auth (Google) + Firestore. Access and pick-timing
  rules are enforced in [`firestore.rules`](firestore.rules).
- **Automation:** GitHub Actions opens gameweeks, pulls results, detects
  forfeits/double gameweeks, and auto-deploys the security rules.

```
index.html            # markup only
styles.css            # all styling
js/
  config.js           # Firebase + game config (teams, chips, thresholds)
  firebase.js         # init + re-exported SDK helpers (CDN version pinned here)
  store.js            # shared mutable state; store.reload() re-renders
  scoring.js          # pure scoring/formatting logic (unit-testable)
  render.js           # view code + pick/chip write actions
  admin.js            # admin result-override + guest-list panels
  app.js              # controller: auth wiring, loadEverything(), boot
advance_gameweek.py   # opens the current gameweek + mirrors fixtures
pull_results.py       # pulls results, detects forfeits/double gameweeks
firestore.rules       # security rules (access + pick-timing enforcement)
firebase.json         # points the Firebase CLI at the rules
test/                 # unit tests for the Python sync logic
.github/workflows/    # ci (tests) · sync (data) · deploy-rules
docs/                 # SETUP, TODO, MONETISATION
```

## Setup

Full step-by-step (Firebase project, Firestore rules, GitHub Pages, the
scheduled sync, branch protection) is in **[`docs/SETUP.md`](docs/SETUP.md)**.

## Development

The Python sync logic is unit-tested (standard library only — no
`pip install` needed):

```sh
python -m unittest discover -s test
```

Quick front-end checks:

```sh
# syntax-check the modules
for f in js/*.js; do node --check "$f"; done

# run locally (Google sign-in works against the live Firebase project)
python -m http.server 8000   # then open http://localhost:8000
```

CI (`.github/workflows/ci.yml`) runs the Python tests on every push and PR;
`main` is protected so changes land via reviewed, green PRs. Merging a change
to `firestore.rules` auto-deploys it (`deploy-rules.yml`).

## Docs

- [`docs/SETUP.md`](docs/SETUP.md) — setup, running week to week, house rules.
- [`docs/MONETISATION.md`](docs/MONETISATION.md) — notes on if/how to monetise.
- [`docs/TODO.md`](docs/TODO.md) — running task list.
