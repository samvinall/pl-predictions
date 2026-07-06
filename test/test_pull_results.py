"""Unit tests for the pure logic in pull_results.py.

These deliberately avoid the network and Firestore -- they exercise the
functions that turn raw FPL fixture data into result documents, match
team names, and guard against stale-season data. Run with:

    python -m unittest discover -s test

No third-party dependencies required (see the import note in
pull_results.py).
"""

import os
import sys
import unittest

# Make the repo root importable when run from anywhere.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pull_results as pr


# Ids -> raw FPL names, including a deliberately awkward spelling.
TEAM_NAMES = {
    1: "Arsenal",
    2: "Chelsea",
    3: "Nott'm Forest",   # must alias to "Nottingham Forest"
    4: "Liverpool",
    5: "Hull City",       # a 2026/27 promoted club
}


def fixture(event, home, away, hs=None, aws=None, finished=False):
    return {
        "event": event, "team_h": home, "team_a": away,
        "team_h_score": hs, "team_a_score": aws, "finished": finished,
    }


def find(results, team, gw):
    return next((r for r in results if r["team"] == team and r["gameweek"] == gw), None)


class TeamNameMatching(unittest.TestCase):
    def test_exact_match(self):
        self.assertEqual(pr.match_team_name("Arsenal", set()), "Arsenal")

    def test_alias(self):
        self.assertEqual(pr.match_team_name("Nott'm Forest", set()), "Nottingham Forest")
        self.assertEqual(pr.match_team_name("Spurs", set()), "Tottenham Hotspur")

    def test_case_insensitive(self):
        self.assertEqual(pr.match_team_name("  liverpool ", set()), "Liverpool")

    def test_unmatched_is_logged_and_none(self):
        log = set()
        self.assertIsNone(pr.match_team_name("Some FC That Doesn't Exist", log))
        self.assertIn("Some FC That Doesn't Exist", log)


class CurrentSeasonGuard(unittest.TestCase):
    def test_true_when_promoted_club_present(self):
        self.assertTrue(pr.is_current_season_data(TEAM_NAMES))

    def test_false_without_promoted_clubs(self):
        last_season = {1: "Arsenal", 2: "Chelsea", 4: "Liverpool"}
        self.assertFalse(pr.is_current_season_data(last_season))


class BuildResults(unittest.TestCase):
    def test_home_win_scores_and_goals(self):
        results, scheduled, pending = pr.build_results(
            TEAM_NAMES, [fixture(1, 1, 2, hs=2, aws=0, finished=True)]
        )
        arsenal = find(results, "Arsenal", 1)
        chelsea = find(results, "Chelsea", 1)
        self.assertEqual(arsenal["results"], ["win"])
        self.assertEqual(arsenal["goals"], [2])
        self.assertEqual(arsenal["conceded"], [0])
        self.assertEqual(chelsea["results"], ["loss"])
        self.assertEqual(chelsea["goals"], [0])
        self.assertEqual(chelsea["conceded"], [2])
        self.assertEqual(scheduled[1], {"Arsenal", "Chelsea"})
        self.assertEqual(pending, {})

    def test_draw(self):
        results, _, _ = pr.build_results(
            TEAM_NAMES, [fixture(2, 1, 4, hs=1, aws=1, finished=True)]
        )
        for team in ("Arsenal", "Liverpool"):
            r = find(results, team, 2)
            self.assertEqual(r["results"], ["draw"])
            self.assertEqual(r["goals"], [1])
            self.assertEqual(r["conceded"], [1])

    def test_unfinished_is_pending_and_unscored(self):
        results, scheduled, pending = pr.build_results(
            TEAM_NAMES, [fixture(3, 1, 2, finished=False)]
        )
        self.assertEqual(results, [])            # nothing scored yet
        self.assertTrue(pending.get(3))          # flagged pending
        self.assertEqual(scheduled[3], {"Arsenal", "Chelsea"})  # still scheduled

    def test_double_gameweek_accumulates(self):
        # Arsenal plays twice in GW4: beats Chelsea 2-1 (home), wins 3-0 at Liverpool.
        fixtures = [
            fixture(4, 1, 2, hs=2, aws=1, finished=True),
            fixture(4, 4, 1, hs=0, aws=3, finished=True),
        ]
        results, _, _ = pr.build_results(TEAM_NAMES, fixtures)
        arsenal = find(results, "Arsenal", 4)
        self.assertEqual(arsenal["results"], ["win", "win"])
        self.assertEqual(sorted(arsenal["goals"]), [2, 3])
        self.assertEqual(sorted(arsenal["conceded"]), [0, 1])

    def test_fixture_without_gameweek_is_skipped(self):
        results, scheduled, _ = pr.build_results(
            TEAM_NAMES, [fixture(None, 1, 2, hs=1, aws=0, finished=True)]
        )
        self.assertEqual(results, [])
        self.assertEqual(scheduled, {})


class _FakeDoc:
    def __init__(self, data):
        self._data = data

    def to_dict(self):
        return self._data


class _FakeDB:
    """Just enough of the Firestore client for detect_forfeits()."""
    def __init__(self, picks):
        self._picks = [_FakeDoc(p) for p in picks]

    def collection(self, name):
        assert name == "picks"
        return self

    def get(self):
        return self._picks


class DetectForfeits(unittest.TestCase):
    def test_flags_pick_whose_team_didnt_play(self):
        db = _FakeDB([
            {"gameweek": 1, "team": "Arsenal"},   # played -> not a forfeit
            {"gameweek": 1, "team": "Everton"},   # not scheduled -> forfeit
        ])
        forfeits = pr.detect_forfeits(db, {1: {"Arsenal", "Chelsea"}}, {})
        self.assertEqual(forfeits, [{"gameweek": 1, "team": "Everton", "results": ["forfeit"]}])

    def test_no_forfeits_while_gameweek_still_pending(self):
        db = _FakeDB([{"gameweek": 1, "team": "Everton"}])
        forfeits = pr.detect_forfeits(db, {1: {"Arsenal", "Chelsea"}}, {1: True})
        self.assertEqual(forfeits, [])


if __name__ == "__main__":
    unittest.main()
