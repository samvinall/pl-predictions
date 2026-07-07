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


if __name__ == "__main__":
    unittest.main()
