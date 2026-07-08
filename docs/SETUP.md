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
5. Deploy the rules. Two ways:
   - **By hand (one-off / no CI):** in the Firebase console, go to
     **Firestore Database → Rules** tab, paste the full contents of
     `firestore.rules` in, replacing the default, and click **Publish**.
   - **Automatically (recommended once CI is set up):** a GitHub Action
     re-publishes `firestore.rules` for you whenever it changes on `main`
     — see *Auto-deploying the security rules* below.

## Auto-deploying the security rules

You don't have to paste rules into the console by hand every time you
change them. `.github/workflows/deploy-rules.yml` runs the Firebase CLI
(`firebase deploy --only firestore:rules`) whenever `firestore.rules`
changes on `main`, so the live rules always match what's been reviewed and
merged. It reuses the same `FIREBASE_SERVICE_ACCOUNT` secret as the data
sync (Part 6) and reads `firebase.json`, which just points at the rules
file. You can also trigger it by hand from the **Actions** tab
(**Deploy Firestore Rules → Run workflow**).

**One permissions gotcha:** the service-account key Firebase generates
(`Project settings → Service accounts`) can *read/write data* by default
but **can't deploy rules** — that needs extra permissions. Deploying both
publishes the rules *and* checks (via the Service Usage API) that Firestore
is enabled, so two roles are required. Symptom of missing them is a `403`
like `Permission denied to get service [firestore.googleapis.com]`.

Grant the service account these roles:

- Google Cloud console → **IAM & Admin → IAM** for the `pl-predictions-sv`
  project → find the `firebase-adminsdk-...@pl-predictions-sv.iam.gserviceaccount.com`
  principal → **Edit (pencil)** → **Add another role**, and add both:
  - **Firebase Rules Admin** (`roles/firebaserules.admin`) — publishes rules
  - **Service Usage Consumer** (`roles/serviceusage.serviceUsageConsumer`)
    — satisfies the "is the API enabled?" check
- Save, then re-run the workflow from the **Actions** tab.

(Simpler but broader: a single **Editor** role includes both.)

Do the very first publish by hand (the console method above) so the app is
protected immediately; the workflow then keeps it in sync from there on.
The project id in the workflow (`pl-predictions-sv`) must match your
Firebase project — change it if you forked this for a different project.

## Part 4 — Host it on GitHub Pages

1. Create a new GitHub repo (public or private — Pages works with
   both on paid plans; public repos get Pages free).
2. Push the front-end to the root of the repo: `index.html`, `styles.css`,
   and the `js/` folder (the app is plain ES modules — no build step, the
   browser loads `js/app.js` and its imports directly). The
   `firestore.rules` and this `SETUP.md` don't need to be public-facing,
   but it's fine to include them for your own records.
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
warning and exits without writing anything (with a distinct exit code,
`78`), so nothing stale ever gets written to Firestore.

Because this is *expected* outside the season, the workflow doesn't spam
you about it: instead of failing (red X) on every 2-hourly run, it
**opens a single GitHub issue** the first time it sees stale data —
titled "FPL sync paused…" and assigned to you — and then stays quiet on
every following run while that issue is open. As soon as the API rolls
over to real 2026/27 data, the next run **closes the issue
automatically** and resumes. Genuine failures (a real bug, or the FPL
API being down — any exit code other than 0 or 78) still fail the run
and email you as normal.

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
anything week to week anymore. The one *expected* non-failure state,
"FPL still serving last season's data", is surfaced as a self-closing
GitHub issue rather than a red X (see the note above), so a run staying
green doesn't necessarily mean data was written pre-season.

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

## Guest list (who's allowed in)

Google Sign-In will let *anyone* with a Google account get as far as the
sign-in popup — Firebase mints them a token no matter what. So access is
controlled by a **guest list** rather than by blocking sign-in:

- The list lives in Firestore at `config/allowlist` as a document with a
  single field `emails` (an array of lower-cased addresses).
- When someone signs in, the app checks their email against that list. If
  it's not there (and they're not the admin), they're immediately signed
  back out and shown a "not on the guest list" screen — they never see the
  app or any data.
- This is also enforced by the security rules: `results` and `picks` can
  only be read or written by an allow-listed account (or the admin), so a
  determined person can't pull the data out via dev tools even if they got
  past the UI. The admin (`ADMIN_EMAIL`) is always allowed, in the list or
  not.

**Managing the list:** sign in as the admin and use the **Admin — Guest
List** card at the bottom of the page. Type an email and click **Add**, or
click **Remove** next to anyone already on it. Matching is case-insensitive
and emails are stored lower-cased. No Firestore console needed — it works
from your phone, same as the manual result override.

The very first time, the list is empty and only you (the admin) can get in
— add everyone else from the admin card once you're signed in.

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
- **Double Chance** — a draw scores the same as a win this week (your team
  only needs to avoid defeat). In a double gameweek, each win *or* draw
  scores. A draw played this way earns points but still shows as a "D" in
  your form and doesn't count towards the "Won" column — only real wins do.
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
- **Multipick** — back **two** teams this week; if *either* wins you score a
  flat win point (winning with both still scores just the one — it's a safety
  net, not a doubler). The unique-pick bonus applies if the **winning** team is
  unique, doubling the point. The catch: **both** teams are then used up for
  the no-repeat rule, so you burn two of your teams for the safety.

A chip played on a **forfeited** week (your team's match didn't happen)
doesn't count — it isn't scored, isn't shown in the league-table Chips column,
and isn't consumed from your once-per-half allowance, so you can play it again.

Chips are stored as an optional `chip` field (`"double"`,
`"doublechance"`, `"goalfest"`, `"scorecard"`, or `"multipick"`) on the pick
document; Scorecard also stores a `scorecard: { for, against }` map, and
Multipick stores its second team as `team2`. No security-rule change is
needed. Scoring lives in shared `scorePick()` / `scoreMultipick()` functions
used by both the league table and the history view.

## Goals (for the Goalfest & Scorecard chips)

To score these chips, results need the scoreline. `pull_results.py`
stores two **arrays** on each result document, aligned to the `results`
array: `goals` (scored by the picked team) and `conceded` (scored
against it) — e.g. `results: ["win"]`, `goals: [3]`, `conceded: [1]`.
The manual admin override panel has **"Goals for"** and **"Goals
against"** boxes for the same purpose. If goals are unknown for a result
(older data, or left blank), Goalfest falls back to scoring that week as
an ordinary win, and Scorecard simply can't register a hit.

## Fixtures list & schedule

`advance_gameweek.py` mirrors the whole-season calendar — per-gameweek
deadlines and fixtures — into `config/schedule` (the browser can't call the
FPL API directly; it serves no CORS headers). The **Gameweeks** tab reads that
doc to show each week's fixtures and to let players pre-pick future weeks, with
live scores as games finish. The firestore rules also index into
`config/schedule.deadlines` to lock each pick at its week's real kickoff.
`config/current` still tracks which week is live, and `config/fixtures` (the
current week only) is kept for backwards-compatibility. `config/*` is readable
by any signed-in user, so no extra security rule is needed.

### Testing future-week selection out of season

Out of season the FPL API serves last season's data, and the normal sync
refuses to write it. To exercise the Gameweeks tab / pre-picking against real
fixtures before the new season's data exists, seed test data:

```bash
python3 advance_gameweek.py --test          # last season, all dates +1 year
python3 advance_gameweek.py --test --shift-years 1
python3 advance_gameweek.py --clean         # remove everything the seed wrote
```

The seed writes (all tagged `{ test: true }`) from last season's data, dates
shifted forward so the calendar plays as the upcoming season — every deadline
lands in the real future, so pick-writes are genuinely accepted:

- `config/schedule` + `config/current` — the week calendar (drives the
  Gameweeks tab + pre-picking).
- the `results` collection — real match results, so locked weeks show actual
  scorelines instead of "Pending".
- `config/players` + `config/standings` + `config/season` +
  `config/season_results` — so the **Season** tab is fully populated (Golden
  Boot picker, standings/top scorers, a predictions lock at the GW1 deadline,
  and the real answers for testing resolution).

**This is live data every signed-in player would see**, so only do it in the
off-season. `--clean` removes it all (config test docs + the `source: "test"`
results); it leaves any picks you made — delete those by hand for a clean
slate. The real-season sync also overwrites the seeded docs once actual data
appears.

To see how a week *renders* as current / locked / past without waiting, use the
admin **Time Machine** (Admin tab): set a simulated "now" and the Gameweeks tab
re-renders against it. It's browser-local and never touches data — and it can't
move the server clock the pick-save rules enforce, so a pick you try to save is
still judged against the real deadline.

## Custom display names

Each player can set a display name on the **Settings** tab (overrides their
Google account name everywhere — sheet, table, results). The admin can also
override any name from the **Admin** tab. Names live in `profiles/{uid}` and
are resolved at render time, so a change applies retroactively to past
gameweeks too.

## Season predictions (Golden Boot & champion)

A **Season** tab lets each player predict, once, before the transfer window
shuts:

- **Golden Boot** — the season's top scorer, chosen from a type-to-search list
  of every PL player. Worth **10 pts**, doubled to **20** if you're the only
  one to pick that player.
- **Champion** (optional) — worth **5 pts**, doubled to **10** if unique.

Mechanics:

- **Lock:** you set the deadline (the transfer-window close) once in
  **Admin → Season Predictions** — a date/time picker writing
  `config/season.predictionsDeadline`. Picks are changeable until then, and
  hidden from other players until then (enforced by `firestore.rules`), same as
  weekly picks.
- **The Season tab also shows** the live PL top 4 and current top
  scorers/assists, mirrored by `advance_gameweek.py` into `config/standings`
  (computed from the season's finished fixtures + the FPL player stats). The
  player list is mirrored into `config/players`.
- **Resolution:** at season end, set the actual Golden Boot winner and champion
  in **Admin → Season Predictions**. Correct predictions get their bonus added
  to the league table (shown as a ⭐ tag by the player's name).

Data lives in `season_picks/{uid}` (one per player) and `config/season*` docs;
the only new security rule is for `season_picks` (own is always readable/
writable pre-deadline; everyone's readable once it locks).

## Front-end architecture

The web app is plain ES modules (no bundler, no build step — the browser
loads them straight from GitHub Pages), split by responsibility:

- `index.html` — markup only.
- `styles.css` — all styling.
- `js/config.js` — Firebase + game config (teams, chips, thresholds, admin
  email). This is the file you edit to tune the rules.
- `js/firebase.js` — initialises Firebase once and re-exports the SDK
  helpers, so the CDN version is pinned in one place.
- `js/store.js` — shared mutable state; `store.reload()` re-fetches and
  re-renders everything.
- `js/scoring.js` — pure scoring/formatting logic (no DOM, no network).
- `js/render.js` — all the view code + the pick/chip write actions.
- `js/admin.js` — the two admin-only panels (result override, guest list).
- `js/app.js` — the controller: auth wiring, `loadEverything()`, boot.

Modules stay decoupled by talking through `store` rather than importing
the controller (the view calls `store.reload()` after a write).

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
