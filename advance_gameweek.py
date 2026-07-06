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

import requests
from datetime import datetime, timezone
from pull_results import get_db  # reuses the same Firebase admin connection

FPL_BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/"


def parse_fpl_timestamp(ts):
    # FPL timestamps look like "2026-08-21T19:00:00Z"
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def main():
    data = requests.get(FPL_BOOTSTRAP, timeout=15).json()
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


if __name__ == "__main__":
    main()
