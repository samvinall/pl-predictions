# Prem Picks 26/27 — Setup Guide

This app is a single static site (`index.html`) hosted free on GitHub
Pages, backed by Firebase (Google's free-tier Auth + database) for
sign-in and data storage. No server to run or maintain.

Total setup time: ~20 minutes, one-off.

---

## Part 1 — Create the Firebase project

1. Go to https://console.firebase.google.com and click **Add project**.
   Name it anything (e.g. "prem-picks"). You can skip Google Analytics.
2. Once created, click the **web icon (`</>`)** on the project overview
   page to register a web app. Give it any nickname. You do **not**
   need Firebase Hosting — you're using GitHub Pages instead.
3. Firebase will show you a `firebaseConfig` object like:

   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "prem-picks.firebaseapp.com",
     projectId: "prem-picks",
     storageBucket: "prem-picks.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abcdef"
   };
   ```

   Copy this whole block — you'll paste it into `index.html` in Part 3.

## Part 2 — Turn on Google Sign-In and Firestore

1. In the left sidebar: **Build → Authentication → Get started**.
   Under "Sign-in method", enable **Google**. Set a support email
   (your own is fine).
2. Still in Authentication → Settings → **Authorized domains**: add
   your future GitHub Pages domain, e.g. `yourusername.github.io`
   (you can also do this after Part 4 once you know the exact URL).
3. In the left sidebar: **Build → Firestore Database → Create database**.
   Choose **Production mode** (not test mode) and pick any region
   close to you. Production mode means nothing is readable/writable
   until we explicitly allow it via rules — which is what
   `firestore.rules` does.

## Part 3 — Configure the app files

1. Open `index.html` and find the `firebaseConfig` object near the
   top of the `<script type="module">` block. Replace it with the one
   you copied in Part 1.
2. In the same file, find `TEAMS`, `UNLOCK_GAMEWEEK`,
   `UNIQUE_THRESHOLD`, `BONUS_MULTIPLIER`, `CHIPS`, and
   `SCORECARD_BONUS` near the top of the script — adjust to match
   whatever you finalize with your friends. `UNLOCK_GAMEWEEK` also marks
   the split between the two halves for chip usage.
3. Open `firestore.rules` and replace `YOUR_ADMIN_EMAIL@gmail.com`
   with the Google account email you'll use as the admin (the one
   entering results each week).
4. **Also set that same email** as `ADMIN_EMAIL` near the top of the
   `<script>` block in `index.html` — this is what reveals the admin
   override panel to you (and only you) once signed in. It must match
   the rules file exactly, or the panel won't work.
5. Deploy the rules. Easiest way without installing anything:
   - In the Firebase console, go to **Firestore Database → Rules** tab.
   - Paste the full contents of `firestore.rules` in, replacing the
     default, and click **Publish**.

## Part 4 — Host it on GitHub Pages

1. Create a new GitHub repo (public or private — Pages works with
   both on paid plans; public repos get Pages free).
2. Push `index.html` to the root of the repo (the `firestore.rules`
   and this `SETUP.md` don't need to be public-facing, but it's fine
   to include them for your own records).
3. In the repo: **Settings → Pages → Source**, choose the `main`
   branch and `/ (root)` folder, then **Save**.
4. GitHub gives you a URL like `https://yourusername.github.io/repo-name/`.
   Open it — you should see the sign-in screen.
5. Go back to Firebase → Authentication → Settings → Authorized
   domains, and make sure `yourusername.github.io` is listed (add it
   if not). Without this, Google Sign-In will fail on the live site.

## Part 5 — Running it week to week

Each week, before picks should open, go to Firestore Database in the
Firebase console and:

1. Open (or create) the `config` collection → document ID `current`.
2. Set two fields:
   - `gameweek` (number) — e.g. `1`
   - `deadline` (timestamp) — set it to the kickoff time of the first
     match in that gameweek. Firestore's console has a timestamp
     picker built in.
3. Save. The app will now show that gameweek as open until the
   deadline passes.

After the gameweek's matches finish, add results:

1. Go to the `results` collection, and add one document per team
   that was picked that week (you don't need one for every PL team,
   just the ones someone picked). Suggested doc ID: `gw1_Arsenal`.
2. Fields: `gameweek` (number), `team` (string, must match the exact
   spelling in the `TEAMS` list in `index.html`), `result` (string:
   `"win"`, `"draw"`, or `"loss"`).
3. Refresh the app — the leaderboard recalculates automatically from
   picks + results, nothing to compute by hand.

## A note on testing before the season actually starts

The FPL API sometimes keeps serving the **previous completed season's**
data for weeks after fixtures are announced — it doesn't necessarily
"roll over" to the new season until shortly before kickoff. If you run
`pull_results.py` or `advance_gameweek.py` well before August, there's
a real chance the FPL bootstrap data still reflects 2025/26 (old
teams, old finished results), which would otherwise get written into
your `results`/`config` collections as if it were real.

Both scripts now guard against this automatically: they check whether
any of this season's promoted clubs (Coventry City, Ipswich Town, Hull
City) appear in the API's team list. If none do, the script prints a
warning and exits without writing anything — and because it exits with
a non-zero status, the GitHub Actions run shows as failed (red X) so
you'll notice, rather than it quietly succeeding while doing nothing
or, worse, writing stale data. This is expected and harmless if you
see it before the season starts — it'll resolve itself once FPL
switches over.

**If you already ran the scripts before this guard existed** and
suspect stale data got written: Firestore console → `results`
collection → three-dot menu next to the collection name → **Delete
collection** → confirm. Also check `config/current` and delete it if
the `gameweek` number looks wrong (e.g. doesn't correspond to anything
sensible) — a fresh run of `advance_gameweek.py` will recreate it
correctly once the API has real 2026/27 data.

## What's enforced automatically vs. what relies on trust

**Enforced by Firestore security rules (can't be bypassed, even via
browser dev tools):**
- You can only ever submit or change a pick under your own signed-in
  identity.
- Picks can be changed as many times as you like, but only up until
  the gameweek's deadline (kickoff of the first match) — after that,
  Firestore itself refuses the write, not just the interface.
- Only your admin account can set gameweeks or enter results.

**Handled by the scheduled GitHub Actions sync (Part 6), not by you:**
- Gameweeks open automatically at the right time — no manual step to
  forget.
- Deadlines come straight from FPL's own timestamps, so there's no
  timezone-entry mistake to make.

**Enforced by the interface, not the server (a determined person
could bypass with dev tools, but it'd be visible in the raw Firestore
data if you ever checked):**
- The "can't repick a team until gameweek 20" rule. The UI greys out
  and disables used teams, but this isn't double-checked server-side.

## House rule: postponed/moved fixtures

If someone's picked team doesn't end up playing in its intended
gameweek (fixture moved elsewhere), that week scores 0 for them — but
the team is **not** considered used, so they can pick it again the
following week. `pull_results.py` detects this automatically: once a
gameweek's fixtures are all finished, any pick whose team isn't among
them gets written as a `"forfeit"` result. The app already treats
`"forfeit"` as 0 points and doesn't lock the team.

Gameweeks themselves follow the official FPL fixture list, including
however FPL tags rearranged games — this means postponements are
resolved by an official neutral source rather than a judgement call
either of you has to make.

## Part 6 — Full automation with GitHub Actions

This makes gameweeks open automatically (correct deadline, correct
timezone, no manual Firestore console step) and pulls results/detects
forfeits on a schedule — nobody needs to visit the app or run anything
by hand.

1. In the Firebase console: **Project settings → Service accounts →
   Generate new private key** (same one used for `pull_results.py` if
   you've already done that step — you can reuse the same file).
2. Open the downloaded JSON file, select all its contents, copy it.
3. In your GitHub repo: **Settings → Secrets and variables → Actions →
   New repository secret**. Name it exactly `FIREBASE_SERVICE_ACCOUNT`,
   and paste the full JSON content as the value.
4. Push `advance_gameweek.py`, `pull_results.py`, and the
   `.github/workflows/sync.yml` file (already included) to your repo.
5. That's it — GitHub will now run both scripts automatically every 2
   hours (see the `cron` line in `sync.yml` if you want to change the
   frequency). You can also trigger it manually anytime: go to the
   **Actions** tab in your repo → **Sync Prem Picks Data** → **Run
   workflow**.

You'll still want to glance at the Actions tab occasionally (green
tick = ran fine, red X = something broke, e.g. the FPL API being
briefly unavailable) — but nothing depends on you remembering to do
anything week to week anymore.

## Manual result override (backup for when the API is down or wrong)

Sign in as your admin account and you'll see an extra card at the
bottom of the page: **Admin — Manual Result Override**. Enter a
gameweek, team, and result, and it writes straight to Firestore —
no console needed, works from your phone.

Anything entered this way is tagged `source: "manual"`, and
`pull_results.py` checks for that tag before writing anything: if a
result already exists with `source: "manual"`, the script leaves it
alone rather than overwriting it with whatever it computes from the
API. So if the automated pull ever gets something wrong (or can't run
at all because the FPL API is down), your manual fix always sticks —
you don't need to worry about it getting silently reverted later.

## Double gameweeks

Occasionally a team plays twice within the same gameweek (fixture
congestion catch-up, common later in the season). House rule: scoring
is per-win — winning both fixtures scores double points, same value
as a unique-pick bonus stacking on top if applicable. This is handled
automatically by `pull_results.py`, which detects it from the FPL
fixture list and prints an info line when it happens.

Because of this, each result document in Firestore stores a `results`
**array** rather than a single value — e.g. `["win"]` normally, or
`["win", "loss"]` for a double gameweek split result. If you're ever
looking directly at the Firestore data, that's why the field looks
like a list.

If you need to enter a double-gameweek result manually (API down),
tick **"Double gameweek — add as extra fixture"** in the admin panel
before submitting the second result — this appends to the array
instead of replacing it.

## Chips

Each player can play at most **one chip per gameweek**, and each chip
can be used **once per half-season** (the two halves split at
`UNLOCK_GAMEWEEK`, i.e. GW1–19 and GW20+). Chips are chosen in the
"Your Pick" card and, like picks, stay hidden from rivals and are
changeable right up to the deadline. Chip effects **stack** with the
unique-pick bonus.

- **Double Down** — doubles that week's win points.
- **Goalfest** — if your team wins, you score the number of goals your
  team scored that fixture, instead of the flat win point. (In a double
  gameweek it sums the goals from each winning fixture.)
- **Scorecard** — predict the exact scoreline of your team's match; nail
  it for a flat **+5** (set by `SCORECARD_BONUS`), *regardless* of the
  result — you can score it on a losing scoreline. The prediction is
  entered from your team's perspective ("your team _ – _ opponent"), so
  home/away doesn't matter. The +5 is flat and is **not** multiplied by
  the unique-pick bonus. In a double gameweek the prediction is judged
  against the team's **first** fixture only, not whichever one happens
  to fit.

Chips are stored as an optional `chip` field (`"double"`, `"goalfest"`,
or `"scorecard"`) on the pick document; Scorecard also stores a
`scorecard: { for, against }` map. No security-rule change is needed.
Scoring lives in one shared `scorePick()` function used by both the
league table and the history view.

## Goals (for the Goalfest & Scorecard chips)

To score these chips, results need the scoreline. `pull_results.py`
stores two **arrays** on each result document, aligned to the `results`
array: `goals` (scored by the picked team) and `conceded` (scored
against it) — e.g. `results: ["win"]`, `goals: [3]`, `conceded: [1]`.
The manual admin override panel has **"Goals for"** and **"Goals
against"** boxes for the same purpose. If goals are unknown for a result
(older data, or left blank), Goalfest falls back to scoring that week as
an ordinary win, and Scorecard simply can't register a hit.

## Fixtures list

`advance_gameweek.py` mirrors the current gameweek's fixtures into
`config/fixtures` (the browser can't call the FPL API directly — it
serves no CORS headers). The app reads that doc to show the fixtures
rail, with live scores as games finish. `config/*` is already readable
by any signed-in user, so no extra security rule is needed.

## Development, testing & CI

Unit tests cover the pure logic in `pull_results.py` — turning FPL
fixtures into results, team-name matching, the stale-season guard, and
forfeit detection. They're standard-library only (no `pip install`
needed). Run them with:

```
python -m unittest discover -s test
```

**Run tests automatically before every push** (local safety net):

```
git config core.hooksPath .githooks
```

That points git at the committed `.githooks/pre-push`, which runs the
tests and blocks the push if any fail (override in a pinch with
`git push --no-verify`).

**CI** (`.github/workflows/ci.yml`) runs the same tests on every push
and every pull request. This is the enforced gate — see below.

## Protecting `main`

The site is served by GitHub Pages straight from `main`, so whatever
lands on `main` goes live. Lock it down so changes can only arrive via a
reviewed, tested pull request:

1. GitHub → repo **Settings → Branches → Add branch ruleset** (or
   "Add rule" under classic branch protection). Target branch: `main`.
2. Enable **Require a pull request before merging**. (Leave "require
   approvals" at 0 if you're solo, otherwise you won't be able to merge
   your own PRs.)
3. Enable **Require status checks to pass before merging**, and select
   the **`python-tests`** check (it appears in the list after the CI
   workflow has run at least once). Tick **Require branches to be up to
   date** too.
4. Enable **Block force pushes** and **Restrict deletions**.
5. Save.

From then on you can't `git push` to `main` directly — you branch, push,
open a PR, let CI go green, and merge. Prefer the CLI? With the `gh`
tool authenticated:

```
gh api -X PUT repos/samvinall/pl-predictions/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f 'required_pull_request_reviews[required_approving_review_count]=0' \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=python-tests' \
  -f 'enforce_admins=true' \
  -f 'restrictions=null'
```