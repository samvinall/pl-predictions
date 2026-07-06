"""
Auto-advance the open gameweek in Firestore.
==============================================

Keeps config/current pointed at the correct gameweek and deadline,
derived directly from the FPL API's own fixture calendar. Designed to
run on a schedule (see .github/workflows/sync.yml) so nobody has to
remember to open a gameweek manually, and deadlines always match the
official kickoff time exactly (in UTC, converted correctly by
Firestore) rather than something typed by hand into the console.

Logic: find the gameweek with the soonest deadline that hasn't passed
yet, and set config/current to that. As soon as one gameweek's
deadline passes, this will naturally flip to the next one on its next
run.

SETUP
------
Runs as part of the same GitHub Actions workflow as pull_results.py,
reusing the same serviceAccountKey.json / Firestore connection -- see
SETUP.md for the one-off setup.
"""

import sys
from datetime import datetime, timezone
# reuses the same checks + team-name matching table
from pull_results import get_db, is_current_season_data, match_team_name
# `requests` is imported lazily inside the functions that use it, so this
# module stays importable with only the standard library (see the note in
# pull_results.py).

FPL_BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/"
FPL_FIXTURES = "https://fantasy.premierleague.com/api/fixtures/"


def write_fixtures(db, gw_number, team_id_to_name):
    """Write the current gameweek's fixtures to config/fixtures so the web
    app can display them. The browser can't call the FPL API directly (it
    serves no CORS headers), so we mirror the fixture list into Firestore
    here. config/* is already readable by any signed-in user, so no extra
    security rule is needed."""
    import requests
    fixtures = requests.get(FPL_FIXTURES, params={"event": gw_number}, timeout=15).json()
    unmatched = set()
    rows = []
    for fx in fixtures:
        home_raw = team_id_to_name.get(fx["team_h"], "?")
        away_raw = team_id_to_name.get(fx["team_a"], "?")
        kickoff = fx.get("kickoff_time")
        rows.append({
            "home": match_team_name(home_raw, unmatched) or home_raw,
            "away": match_team_name(away_raw, unmatched) or away_raw,
            # datetime -> Firestore Timestamp; None for not-yet-scheduled games
            "kickoff": parse_fpl_timestamp(kickoff) if kickoff else None,
            "home_score": fx.get("team_h_score"),
            "away_score": fx.get("team_a_score"),
            "finished": bool(fx.get("finished")),
            "started": bool(fx.get("started")),
        })
    # Kick off order; undated fixtures (kickoff None) sort last.
    far_future = datetime.max.replace(tzinfo=timezone.utc)
    rows.sort(key=lambda r: r["kickoff"] or far_future)

    db.collection("config").document("fixtures").set({
        "gameweek": gw_number,
        "fixtures": rows,
        "updated": datetime.now(timezone.utc),
    })
    print(f"✅ Wrote {len(rows)} fixtures for GW{gw_number} to config/fixtures.")


def parse_fpl_timestamp(ts):
    # FPL timestamps look like "2026-08-21T19:00:00Z"
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def main():
    import requests
    data = requests.get(FPL_BOOTSTRAP, timeout=15).json()
    team_id_to_name = {t["id"]: t["name"] for t in data["teams"]}

    if not is_current_season_data(team_id_to_name):
        print("🛑 The FPL API still appears to be serving last season's data — "
              "none of this season's promoted clubs (Coventry City, Ipswich "
              "Town, Hull City) were found. Refusing to touch config/current "
              "to avoid setting the wrong gameweek/deadline. This is expected "
              "outside of the season and will resolve itself once FPL rolls "
              "over to 2026/27.")
        sys.exit(1)

    events = data["events"]
    now = datetime.now(timezone.utc)

    upcoming = [e for e in events if parse_fpl_timestamp(e["deadline_time"]) > now]
    if not upcoming:
        print("No upcoming gameweeks found — season may be finished, or fixtures aren't out yet.")
        return

    next_gw = min(upcoming, key=lambda e: e["deadline_time"])
    gw_number = next_gw["id"]
    deadline_dt = parse_fpl_timestamp(next_gw["deadline_time"])

    db = get_db()
    current_doc = db.collection("config").document("current").get()
    already_set = (
        current_doc.exists
        and current_doc.to_dict().get("gameweek") == gw_number
    )

    db.collection("config").document("current").set({
        "gameweek": gw_number,
        "deadline": deadline_dt,
    })

    if already_set:
        print(f"config/current already correct: GW{gw_number}, deadline {deadline_dt.isoformat()}")
    else:
        print(f"✅ Advanced config/current to GW{gw_number}, deadline {deadline_dt.isoformat()}")

    # Refresh the fixtures list for whichever gameweek is now current, so
    # the app can show it (and keep live scores updated as games finish).
    write_fixtures(db, gw_number, team_id_to_name)


if __name__ == "__main__":
    main()
