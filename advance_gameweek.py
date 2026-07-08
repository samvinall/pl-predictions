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
from datetime import datetime, timezone, timedelta
# reuses the same checks + team-name matching table
from pull_results import get_db, is_current_season_data, match_team_name, build_results, EXIT_STALE_SEASON
# `requests` is imported lazily inside the functions that use it, so this
# module stays importable with only the standard library (see the note in
# pull_results.py).

FPL_BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/"
FPL_FIXTURES = "https://fantasy.premierleague.com/api/fixtures/"


def build_fixture_rows(fixtures, team_id_to_name):
    """Turn raw FPL fixture dicts into the compact rows the web app renders,
    with canonical team names and kickoff order (undated games sort last).
    Pure -- no network or db -- so it's shared by write_fixtures (one
    gameweek) and build_schedule (the whole season) and can be unit-tested."""
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
    return rows


def build_schedule(events, all_fixtures, team_id_to_name):
    """Build the whole-season calendar mirrored into config/schedule: a
    per-gameweek deadline map (keyed by gameweek string, so the security
    rules can index straight into it) plus each gameweek's fixture rows.
    This is what lets players look ahead and pre-pick future weeks, with
    each pick locking at that week's real deadline. Pure -- unit-tested."""
    deadlines = {
        str(e["id"]): parse_fpl_timestamp(e["deadline_time"])
        for e in events if e.get("deadline_time")
    }
    by_gw = {}
    for fx in all_fixtures:
        gw = fx.get("event")
        if gw is None:
            continue   # fixtures not yet assigned to a gameweek
        by_gw.setdefault(gw, []).append(fx)
    fixtures_by_gw = {
        str(gw): build_fixture_rows(fxs, team_id_to_name)
        for gw, fxs in by_gw.items()
    }
    return {"deadlines": deadlines, "fixturesByGw": fixtures_by_gw}


def write_fixtures(db, gw_number, team_id_to_name):
    """Write the current gameweek's fixtures to config/fixtures so the web
    app can display them. The browser can't call the FPL API directly (it
    serves no CORS headers), so we mirror the fixture list into Firestore
    here. config/* is already readable by any signed-in user, so no extra
    security rule is needed."""
    import requests
    fixtures = requests.get(FPL_FIXTURES, params={"event": gw_number}, timeout=15).json()
    rows = build_fixture_rows(fixtures, team_id_to_name)

    db.collection("config").document("fixtures").set({
        "gameweek": gw_number,
        "fixtures": rows,
        "updated": datetime.now(timezone.utc),
    })
    print(f"✅ Wrote {len(rows)} fixtures for GW{gw_number} to config/fixtures.")


def parse_fpl_timestamp(ts):
    # FPL timestamps look like "2026-08-21T19:00:00Z"
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


POSITIONS = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}


def build_players(elements, canon_team):
    """Turn the FPL bootstrap `elements` into a compact player list for the
    Golden Boot picker: id, display name, team (canonical), position."""
    players = []
    for e in elements:
        players.append({
            "id": e["id"],
            "name": e.get("web_name", "?"),
            "team": canon_team.get(e.get("team"), "?"),
            "pos": POSITIONS.get(e.get("element_type"), "?"),
        })
    return players


def compute_standings(fixtures, canon_team):
    """Build the league table from all finished fixtures. Returns rows sorted
    by points, then goal difference, then goals for, then name; each row gets a
    1-based `position`. Pure -- unit-tested."""
    table = {}

    def row(team):
        return table.setdefault(team, {
            "team": team, "played": 0, "won": 0, "drawn": 0, "lost": 0,
            "gf": 0, "ga": 0, "points": 0,
        })

    for fx in fixtures:
        if not fx.get("finished"):
            continue
        hs, as_ = fx.get("team_h_score"), fx.get("team_a_score")
        if hs is None or as_ is None:
            continue
        home = canon_team.get(fx.get("team_h"))
        away = canon_team.get(fx.get("team_a"))
        if not home or not away:
            continue
        h, a = row(home), row(away)
        h["played"] += 1; a["played"] += 1
        h["gf"] += hs; h["ga"] += as_
        a["gf"] += as_; a["ga"] += hs
        if hs > as_:
            h["won"] += 1; h["points"] += 3; a["lost"] += 1
        elif hs < as_:
            a["won"] += 1; a["points"] += 3; h["lost"] += 1
        else:
            h["drawn"] += 1; a["drawn"] += 1; h["points"] += 1; a["points"] += 1

    rows = list(table.values())
    for r in rows:
        r["gd"] = r["gf"] - r["ga"]
    rows.sort(key=lambda r: (-r["points"], -r["gd"], -r["gf"], r["team"]))
    for i, r in enumerate(rows):
        r["position"] = i + 1
    return rows


def compute_top_scorers(elements, canon_team, limit=5):
    """Top scorers from the FPL bootstrap, most goals first (assists break
    ties), each with their assist count. Pure -- unit-tested."""
    scorers = [e for e in elements if e.get("goals_scored", 0)]
    scorers.sort(key=lambda e: (-e.get("goals_scored", 0), -e.get("assists", 0), e.get("web_name", "")))
    return [{
        "name": e.get("web_name", "?"),
        "team": canon_team.get(e.get("team"), "?"),
        "goals": e.get("goals_scored", 0),
        "assists": e.get("assists", 0),
    } for e in scorers[:limit]]


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
        sys.exit(EXIT_STALE_SEASON)

    # Canonical (our-spelling) team names, keyed by FPL team id.
    canon_team = {t["id"]: (match_team_name(t["name"], set()) or t["name"]) for t in data["teams"]}

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

    # Mirror the player list (for the Golden Boot picker) and the current
    # standings + top scorers (for the Season tab). All from data we already
    # have, plus the full-season fixtures list for the table.
    db.collection("config").document("players").set({
        "players": build_players(data["elements"], canon_team),
        "updated": datetime.now(timezone.utc),
    })
    all_fixtures = requests.get(FPL_FIXTURES, timeout=15).json()
    db.collection("config").document("standings").set({
        "table": compute_standings(all_fixtures, canon_team),
        "topScorers": compute_top_scorers(data["elements"], canon_team),
        "updated": datetime.now(timezone.utc),
    })
    print(f"✅ Wrote {len(data['elements'])} players + standings to config/*.")

    # Mirror the whole-season calendar (per-gameweek deadlines + fixtures) so
    # the app can let players look ahead and pre-pick future weeks. The
    # security rules index into the deadlines map to lock each pick at that
    # week's real kickoff.
    schedule = build_schedule(events, all_fixtures, team_id_to_name)
    schedule["updated"] = datetime.now(timezone.utc)
    db.collection("config").document("schedule").set(schedule)
    print(f"✅ Wrote schedule for {len(schedule['deadlines'])} gameweeks to config/schedule.")


def shift_year(dt, years):
    """Move a datetime forward by whole calendar years, preserving the tz.
    Feb 29 in a non-leap target year falls back to Feb 28. Pure -- unit-tested."""
    try:
        return dt.replace(year=dt.year + years)
    except ValueError:   # Feb 29 -> non-leap year
        return dt.replace(year=dt.year + years, day=28)


def seed_test_data(shift_years=1, cutoff=None):
    """OFF-SEASON TEST SEED. Builds config/schedule + config/current from
    whatever the FPL API is currently serving (last season, out of season), so
    the future-week feature can be exercised in prod before the real season
    data exists. The normal main() refuses to write stale-season data; this
    opts in explicitly. Everything is tagged { test: True }; run with --clean
    to remove it.

    Two anchoring modes:

    * DEFAULT (`shift_years`): shift every date forward by whole years, so the
      whole calendar sits in the real future. Every week is "upcoming" now;
      use the client Time Machine to scrub how weeks render. Season predictions
      are open, and the final answers are seeded so resolution can be tested.

    * CUTOFF (`cutoff=N`): anchor so gameweek N is the current, still-open week
      RIGHT NOW (its deadline a few days ahead), i.e. simulate being partway
      through the season. Weeks 1..N-1 are locked with real results; weeks
      N+1.. are upcoming and pickable. Standings reflect only the played weeks,
      season predictions are LOCKED (past their deadline) and NOT yet resolved
      (no Final Table) -- a faithful mid-season snapshot against the real clock,
      no Time Machine needed.

    NB: the rules lock picks against the SERVER clock, which no client override
    can move -- both modes place the pickable weeks in the real future so their
    writes are genuinely accepted."""
    import requests
    data = requests.get(FPL_BOOTSTRAP, timeout=15).json()
    team_id_to_name = {t["id"]: t["name"] for t in data["teams"]}
    events = data["events"]
    all_fixtures = requests.get(FPL_FIXTURES, timeout=15).json()
    now = datetime.now(timezone.utc)

    schedule = build_schedule(events, all_fixtures, team_id_to_name)

    if cutoff is not None:
        # Delta-shift so gameweek `cutoff` opens ~3 days from now: earlier weeks
        # land in the past (locked), later weeks in the future (upcoming).
        orig = schedule["deadlines"].get(str(cutoff))
        if orig is None:
            raise SystemExit(f"No gameweek {cutoff} in the fixture data (have "
                             f"{min(int(g) for g in schedule['deadlines'])}.."
                             f"{max(int(g) for g in schedule['deadlines'])}).")
        delta = (now + timedelta(days=3)) - orig
        shift = lambda dt: dt + delta
    else:
        shift = lambda dt: shift_year(dt, shift_years)

    schedule["deadlines"] = {gw: shift(dt) for gw, dt in schedule["deadlines"].items()}
    for rows in schedule["fixturesByGw"].values():
        for r in rows:
            if r["kickoff"] is not None:
                r["kickoff"] = shift(r["kickoff"])
    schedule["updated"] = datetime.now(timezone.utc)
    schedule["test"] = True

    # config/current = earliest week whose (shifted) deadline is still ahead;
    # if the whole shifted season is already behind us, use the last week.
    upcoming = {int(gw): dt for gw, dt in schedule["deadlines"].items() if dt > now}
    cur_gw = min(upcoming, key=lambda g: upcoming[g]) if upcoming \
        else max(int(g) for g in schedule["deadlines"])
    cur_deadline = schedule["deadlines"][str(cur_gw)]

    db = get_db()
    db.collection("config").document("schedule").set(schedule)
    db.collection("config").document("current").set({
        "gameweek": cur_gw, "deadline": cur_deadline, "test": True,
    })

    # Real match RESULTS from last season's finished fixtures (unshifted --
    # results key on gameweek + team, not dates). In cutoff mode only weeks
    # BEFORE the cutoff are "played", so later weeks stay genuinely unplayed.
    # Tagged source "test" so a real-season pull_results run overwrites freely.
    results, _, _ = build_results(team_id_to_name, all_fixtures)
    if cutoff is not None:
        results = [r for r in results if r["gameweek"] < cutoff]
    batch = db.batch()
    for i, r in enumerate(results, 1):
        ref = db.collection("results").document(f"gw{r['gameweek']}_{r['team'].replace(' ', '_')}")
        batch.set(ref, {**r, "source": "test"})
        if i % 400 == 0:
            batch.commit(); batch = db.batch()
    batch.commit()

    # Season-prediction data: player list (Golden Boot picker) + standings/top
    # scorers (Season tab). In cutoff mode standings reflect only the played
    # weeks (a mid-season table); otherwise the full last-season table.
    canon_by_id = {t["id"]: (match_team_name(t["name"], set()) or t["name"]) for t in data["teams"]}
    db.collection("config").document("players").set({
        "players": build_players(data["elements"], canon_by_id),
        "updated": datetime.now(timezone.utc), "test": True,
    })
    table_fixtures = [fx for fx in all_fixtures if cutoff is None or (fx.get("event") or 0) < cutoff]
    table = compute_standings(table_fixtures, canon_by_id)
    db.collection("config").document("standings").set({
        "table": table, "topScorers": compute_top_scorers(data["elements"], canon_by_id),
        "updated": datetime.now(timezone.utc), "test": True,
    })
    # Predictions lock at the shifted GW1 deadline -- future in default mode
    # (open), past in cutoff mode (locked, as they'd be mid-season).
    db.collection("config").document("season").set({
        "predictionsDeadline": schedule["deadlines"]["1"], "test": True,
    })

    if cutoff is not None:
        # Mid-season: the season isn't over, so don't reveal the answers /
        # Final Table. Clear any results a previous full-season seed left.
        db.collection("config").document("season_results").delete()
    else:
        # Full-season sim: seed the actual answers so resolution + the Final
        # Table can be tested.
        scorers = sorted((e for e in data["elements"] if e.get("goals_scored", 0)),
                         key=lambda e: (-e.get("goals_scored", 0), -e.get("assists", 0)))
        season_results = {"test": True}
        if scorers:
            season_results["goldenBootId"] = scorers[0]["id"]
            season_results["goldenBootName"] = scorers[0].get("web_name")
        if table:
            season_results["champion"] = table[0]["team"]
        db.collection("config").document("season_results").set(season_results)

    mode = f"cutoff GW{cutoff} (mid-season)" if cutoff is not None else f"+{shift_years}y (all upcoming)"
    print(f"✅ TEST seed [{mode}]: config/current → GW{cur_gw} "
          f"(deadline {cur_deadline.isoformat()}), {len(schedule['deadlines'])} weeks in "
          f"config/schedule, {len(results)} result records, players + standings + season. "
          f"Run with --clean to remove it all.")


def clean_test_data():
    """Remove everything seed_test_data wrote: the config/* test docs and the
    result records tagged source 'test'. Leaves picks / season_picks alone."""
    db = get_db()
    for name in ("schedule", "current", "players", "standings", "season", "season_results"):
        db.collection("config").document(name).delete()
    batch = db.batch()
    n = 0
    for d in db.collection("results").where("source", "==", "test").stream():
        batch.delete(d.reference); n += 1
        if n % 400 == 0:
            batch.commit(); batch = db.batch()
    batch.commit()
    print(f"🧹 Removed test config docs + {n} test result records. "
          f"(Any picks you made are left in place — delete them by hand if you want a clean slate.)")


if __name__ == "__main__":
    if "--clean" in sys.argv:
        clean_test_data()
    elif "--test" in sys.argv:
        years = 1
        if "--shift-years" in sys.argv:
            years = int(sys.argv[sys.argv.index("--shift-years") + 1])
        cutoff = None
        if "--cutoff" in sys.argv:
            cutoff = int(sys.argv[sys.argv.index("--cutoff") + 1])
        seed_test_data(years, cutoff)
    else:
        main()
