"""
Auto-pull Premier League results and write them into Firestore.
=================================================================

Pulls fixture data from the free, keyless Fantasy Premier League API
(the same source FPL itself uses), which already tags every fixture
with its official gameweek -- including postponed/rearranged games,
which keep their originally-intended gameweek tag even if actually
played later. This means you don't need to manually decide which
"week" a moved game counts for -- just re-run this script periodically
and it'll pick up newly-finished fixtures automatically, whichever
gameweek they belong to.

FORFEITS
--------
House rule: if someone picked a team that doesn't end up playing in
its intended gameweek (fixture moved elsewhere), that week is a 0 for
them -- but the team is NOT considered "used", so they can pick it
again next week. This script detects that automatically: once every
fixture tagged to a gameweek has finished, any pick for that gameweek
whose team isn't among that gameweek's fixtures gets written as a
forfeit (0 points, and index.html already treats forfeited picks as
not locking the team).

DOUBLE GAMEWEEKS
-----------------
House rule: if a team plays twice in one gameweek (a genuine FPL
"double gameweek"), scoring is per-win -- winning both fixtures scores
double points, same as winning once. Because of this, each result
document stores a `results` ARRAY (one entry per fixture that team
played that gameweek), e.g. ["win"] normally, or ["win", "loss"] for a
double gameweek where they won one and lost the other.

SETUP (one-off)
----------------
1. pip install requests firebase-admin
2. In the Firebase console: Project settings (gear icon) -> Service
   accounts -> "Generate new private key". Save the downloaded file
   as serviceAccountKey.json next to this script. This gives the
   script full admin access to Firestore, bypassing security rules --
   appropriate here since only you will run this script.
3. Run it whenever you want to refresh results:
       python pull_results.py
   Safe to re-run anytime (e.g. a weekly cron job, or just manually
   after Saturday/Sunday's matches finish) -- it only overwrites
   results for fixtures the FPL API reports as finished, and does
   nothing to fixtures that haven't been played yet.

TEAM NAME MATCHING
--------------------
The FPL API's team names don't always exactly match the spelling used
in index.html's TEAMS list (e.g. it may say "Nott'm Forest" instead of
"Nottingham Forest"). This script tries to auto-match via the ALIASES
table below; anything it can't confidently match gets printed as a
warning so you can add it to ALIASES yourself -- takes 10 seconds.
"""

import requests
import firebase_admin
from firebase_admin import credentials, firestore

# ---------- CONFIG ----------
SERVICE_ACCOUNT_FILE = "serviceAccountKey.json"

# Canonical team names -- must exactly match the TEAMS list in index.html
CANONICAL_TEAMS = [
    "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton",
    "Chelsea", "Coventry City", "Crystal Palace", "Everton", "Fulham",
    "Hull City", "Ipswich Town", "Leeds United", "Liverpool",
    "Manchester City", "Manchester United", "Newcastle United",
    "Nottingham Forest", "Sunderland", "Tottenham Hotspur",
]

# Map common alternate spellings the FPL API might use -> canonical name.
# Add to this if the "unmatched team name" warning shows up when you run it.
ALIASES = {
    "man utd": "Manchester United", "man united": "Manchester United",
    "manchester utd": "Manchester United",
    "man city": "Manchester City",
    "spurs": "Tottenham Hotspur", "tottenham": "Tottenham Hotspur",
    "nott'm forest": "Nottingham Forest", "notts forest": "Nottingham Forest",
    "forest": "Nottingham Forest",
    "newcastle": "Newcastle United",
    "leeds": "Leeds United",
    "brighton & hove albion": "Brighton", "brighton and hove albion": "Brighton",
    "wolves": "Wolverhampton Wanderers",
    "coventry": "Coventry City",
    "ipswich": "Ipswich Town",
    "hull": "Hull City",
}
# -----------------------------

FPL_BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/"
FPL_FIXTURES = "https://fantasy.premierleague.com/api/fixtures/"


def normalize(name):
    return name.strip().lower()


def match_team_name(fpl_name, unmatched_log):
    key = normalize(fpl_name)
    if key in ALIASES:
        return ALIASES[key]
    for canonical in CANONICAL_TEAMS:
        if normalize(canonical) == key:
            return canonical
    # loose fallback: does one contain the other?
    for canonical in CANONICAL_TEAMS:
        c = normalize(canonical)
        if c in key or key in c:
            return canonical
    unmatched_log.add(fpl_name)
    return None


def fetch_fpl_data():
    teams_resp = requests.get(FPL_BOOTSTRAP, timeout=15).json()
    team_id_to_name = {t["id"]: t["name"] for t in teams_resp["teams"]}
    fixtures = requests.get(FPL_FIXTURES, timeout=15).json()
    return team_id_to_name, fixtures


def build_results(team_id_to_name, fixtures):
    """Returns:
    - results: list of {gameweek, team, results: [...]} -- `results` is
      an array with one entry per fixture that team played in that
      gameweek. Normally length 1, but length 2 for a double gameweek
      (scored per-win: winning both fixtures counts as two wins).
    - gw_scheduled_teams: {gameweek: set of team names actually fixtured
      that gameweek, per the FPL API right now}
    - gw_still_pending: {gameweek: True if any fixture tagged to that
      gameweek hasn't finished yet -- used to avoid declaring forfeits
      prematurely}
    """
    unmatched = set()
    team_gw_outcomes = {}  # (gameweek, team) -> [result, ...]

    gw_scheduled_teams = {}
    gw_still_pending = {}

    for fx in fixtures:
        gw = fx.get("event")
        if gw is None:
            continue  # not currently assigned to any gameweek

        home_id, away_id = fx["team_h"], fx["team_a"]
        home_name = match_team_name(team_id_to_name.get(home_id, ""), unmatched)
        away_name = match_team_name(team_id_to_name.get(away_id, ""), unmatched)

        gw_scheduled_teams.setdefault(gw, set())
        if home_name:
            gw_scheduled_teams[gw].add(home_name)
        if away_name:
            gw_scheduled_teams[gw].add(away_name)

        if not fx.get("finished"):
            gw_still_pending[gw] = True
            continue  # not played yet -- handled on a future run

        home_score, away_score = fx["team_h_score"], fx["team_a_score"]
        if home_score > away_score:
            home_result, away_result = "win", "loss"
        elif home_score < away_score:
            home_result, away_result = "loss", "win"
        else:
            home_result, away_result = "draw", "draw"

        for team, result in [(home_name, home_result), (away_name, away_result)]:
            if team is None:
                continue
            team_gw_outcomes.setdefault((gw, team), []).append(result)

    if unmatched:
        print("⚠️  Couldn't match these team names from the FPL API -- add them to ALIASES:")
        for u in sorted(unmatched):
            print(f"    {u!r}")

    results = []
    for (gw, team), outcomes in team_gw_outcomes.items():
        if len(outcomes) > 1:
            print(f"ℹ️  Double gameweek: GW{gw} {team} played {len(outcomes)} fixtures "
                  f"({', '.join(outcomes)}) -- scored per-win.")
        results.append({"gameweek": gw, "team": team, "results": outcomes})

    return results, gw_scheduled_teams, gw_still_pending


def detect_forfeits(db, gw_scheduled_teams, gw_still_pending):
    """For each gameweek that's fully finished (no pending fixtures left
    under that gameweek tag), check every pick made for that gameweek.
    If the picked team isn't in that gameweek's scheduled-team set at
    all, their fixture got moved elsewhere -- that pick is a forfeit."""
    picks_snap = db.collection("picks").get()
    forfeits = []
    for doc in picks_snap:
        p = doc.to_dict()
        gw, team = p.get("gameweek"), p.get("team")
        if gw is None or team is None:
            continue
        if gw_still_pending.get(gw, False):
            continue  # this gameweek isn't fully resolved yet -- check again later
        scheduled = gw_scheduled_teams.get(gw, set())
        if team not in scheduled:
            forfeits.append({"gameweek": gw, "team": team, "results": ["forfeit"]})
    return forfeits


def get_db():
    cred = credentials.Certificate(SERVICE_ACCOUNT_FILE)
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    return firestore.client()


def write_to_firestore(db, results):
    # Don't clobber anything entered by hand via the app's admin panel --
    # if you've corrected something manually, it stays put even if this
    # script runs again later and computes something different.
    existing = db.collection("results").get()
    manual_doc_ids = {d.id for d in existing if d.to_dict().get("source") == "manual"}

    batch = db.batch()
    count = 0
    skipped = 0
    for r in results:
        doc_id = f"gw{r['gameweek']}_{r['team'].replace(' ', '_')}"
        if doc_id in manual_doc_ids:
            skipped += 1
            continue
        ref = db.collection("results").document(doc_id)
        batch.set(ref, {**r, "source": "api"})
        count += 1
        if count % 400 == 0:  # Firestore batch limit is 500
            batch.commit()
            batch = db.batch()
    if count % 400 != 0:
        batch.commit()
    print(f"✅ Wrote {count} result records to Firestore.")
    if skipped:
        print(f"   (skipped {skipped} that were manually entered and left untouched)")


def main():
    team_id_to_name, fixtures = fetch_fpl_data()
    results, gw_scheduled_teams, gw_still_pending = build_results(team_id_to_name, fixtures)

    db = get_db()

    forfeits = detect_forfeits(db, gw_scheduled_teams, gw_still_pending)
    if forfeits:
        print(f"🚩 Detected {len(forfeits)} forfeit(s) — picked team didn't play its gameweek:")
        for f in forfeits:
            print(f"    GW{f['gameweek']} - {f['team']}")
    results.extend(forfeits)

    if not results:
        print("No finished fixtures or forfeits found yet.")
        return
    write_to_firestore(db, results)


if __name__ == "__main__":
    main()
