"""
Unit tests for the pure helpers in advance_gameweek.py — building the player
list and computing the standings + top scorers. Standard-library only
(requests / firebase-admin are imported lazily inside functions), so this
imports cleanly without any network or credentials.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import advance_gameweek as ag


class TestStandings(unittest.TestCase):
    def setUp(self):
        self.canon = {1: "Arsenal", 2: "Chelsea", 3: "Liverpool"}

    def test_points_played_and_order(self):
        fixtures = [
            {"team_h": 1, "team_a": 2, "team_h_score": 2, "team_a_score": 0, "finished": True},   # Arsenal beat Chelsea
            {"team_h": 3, "team_a": 2, "team_h_score": 1, "team_a_score": 1, "finished": True},   # Liverpool draw Chelsea
            {"team_h": 1, "team_a": 3, "team_h_score": 9, "team_a_score": 0, "finished": False},  # unfinished -> ignored
        ]
        table = ag.compute_standings(fixtures, self.canon)
        by = {r["team"]: r for r in table}
        self.assertEqual(by["Arsenal"]["points"], 3)
        self.assertEqual(by["Arsenal"]["won"], 1)
        self.assertEqual(by["Chelsea"]["points"], 1)
        self.assertEqual(by["Chelsea"]["played"], 2)
        self.assertEqual(by["Liverpool"]["points"], 1)
        self.assertEqual(table[0]["team"], "Arsenal")   # most points -> top
        self.assertEqual(table[0]["position"], 1)

    def test_unfinished_or_unknown_ignored(self):
        fixtures = [
            {"team_h": 1, "team_a": 2, "team_h_score": None, "team_a_score": None, "finished": True},
            {"team_h": 1, "team_a": 99, "team_h_score": 1, "team_a_score": 0, "finished": True},  # unknown team id
        ]
        self.assertEqual(ag.compute_standings(fixtures, self.canon), [])

    def test_goal_difference_tiebreak(self):
        fixtures = [
            {"team_h": 1, "team_a": 2, "team_h_score": 5, "team_a_score": 0, "finished": True},   # Arsenal +5
            {"team_h": 3, "team_a": 2, "team_h_score": 1, "team_a_score": 0, "finished": True},   # Liverpool +1
        ]
        table = ag.compute_standings(fixtures, self.canon)
        # Both 3 pts; Arsenal's better GD puts them first.
        self.assertEqual(table[0]["team"], "Arsenal")
        self.assertEqual(table[1]["team"], "Liverpool")


class TestTopScorers(unittest.TestCase):
    def test_sorted_by_goals_excludes_scoreless(self):
        canon = {1: "Arsenal", 2: "Chelsea"}
        elements = [
            {"web_name": "Saka", "team": 1, "goals_scored": 5, "assists": 3},
            {"web_name": "Palmer", "team": 2, "goals_scored": 8, "assists": 2},
            {"web_name": "Rice", "team": 1, "goals_scored": 0, "assists": 4},   # 0 goals -> excluded
        ]
        top = ag.compute_top_scorers(elements, canon, limit=5)
        self.assertEqual([t["name"] for t in top], ["Palmer", "Saka"])
        self.assertEqual(top[0], {"name": "Palmer", "team": "Chelsea", "goals": 8, "assists": 2})


class TestBuildPlayers(unittest.TestCase):
    def test_maps_fields(self):
        canon = {7: "Manchester City"}
        elements = [{"id": 100, "web_name": "Haaland", "team": 7, "element_type": 4}]
        self.assertEqual(
            ag.build_players(elements, canon),
            [{"id": 100, "name": "Haaland", "team": "Manchester City", "pos": "FWD"}],
        )


class TestBuildFixtureRows(unittest.TestCase):
    def setUp(self):
        # FPL raw team names; match_team_name maps them to our canonical spelling.
        self.names = {10: "Man City", 11: "Spurs", 12: "Arsenal"}

    def test_maps_names_scores_and_flags(self):
        rows = ag.build_fixture_rows([
            {"team_h": 10, "team_a": 11, "kickoff_time": "2026-08-21T19:00:00Z",
             "team_h_score": 2, "team_a_score": 1, "finished": True, "started": True},
        ], self.names)
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual(r["home"], "Manchester City")
        self.assertEqual(r["away"], "Tottenham Hotspur")
        self.assertEqual((r["home_score"], r["away_score"]), (2, 1))
        self.assertTrue(r["finished"] and r["started"])
        self.assertIsNotNone(r["kickoff"])

    def test_sorts_by_kickoff_undated_last(self):
        rows = ag.build_fixture_rows([
            {"team_h": 10, "team_a": 11, "kickoff_time": None},
            {"team_h": 12, "team_a": 10, "kickoff_time": "2026-08-21T12:30:00Z"},
            {"team_h": 11, "team_a": 12, "kickoff_time": "2026-08-20T19:00:00Z"},
        ], self.names)
        # Earliest kickoff first; the undated (kickoff None) fixture sorts last.
        self.assertEqual([r["home"] for r in rows], ["Tottenham Hotspur", "Arsenal", "Manchester City"])
        self.assertIsNone(rows[-1]["kickoff"])


class TestBuildSchedule(unittest.TestCase):
    def setUp(self):
        self.names = {10: "Man City", 11: "Spurs", 12: "Arsenal"}
        self.events = [
            {"id": 1, "deadline_time": "2026-08-14T17:30:00Z"},
            {"id": 2, "deadline_time": "2026-08-21T17:30:00Z"},
        ]

    def test_deadlines_keyed_by_gameweek_string(self):
        sched = ag.build_schedule(self.events, [], self.names)
        self.assertEqual(set(sched["deadlines"].keys()), {"1", "2"})
        # Values are parsed datetimes, not raw strings.
        self.assertEqual(sched["deadlines"]["1"].year, 2026)

    def test_fixtures_grouped_by_event_string(self):
        fixtures = [
            {"event": 1, "team_h": 10, "team_a": 11, "kickoff_time": "2026-08-14T19:00:00Z"},
            {"event": 2, "team_h": 12, "team_a": 10, "kickoff_time": "2026-08-21T19:00:00Z"},
            {"event": None, "team_h": 11, "team_a": 12, "kickoff_time": None},  # unassigned -> skipped
        ]
        sched = ag.build_schedule(self.events, fixtures, self.names)
        self.assertEqual(set(sched["fixturesByGw"].keys()), {"1", "2"})
        self.assertEqual(sched["fixturesByGw"]["1"][0]["home"], "Manchester City")
        self.assertEqual(sched["fixturesByGw"]["2"][0]["away"], "Manchester City")

    def test_event_without_deadline_ignored(self):
        events = self.events + [{"id": 3}]  # no deadline_time
        sched = ag.build_schedule(events, [], self.names)
        self.assertNotIn("3", sched["deadlines"])


if __name__ == "__main__":
    unittest.main()
