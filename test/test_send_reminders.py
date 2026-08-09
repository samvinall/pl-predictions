"""
Unit tests for the pure helpers in send_reminders.py (recipient selection,
the 24h due-check, and the message builder). Standard-library only -- the
Firestore/SMTP bits are imported lazily, so this imports without credentials.
"""
import os
import sys
import unittest
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import send_reminders as sr


class TestChooseRecipients(unittest.TestCase):
    def setUp(self):
        self.allow = ["A@x.com", "b@x.com", "c@x.com", "d@x.com"]
        self.paid = ["b@x.com"]
        self.engaged = ["c@x.com", "stranger@x.com"]   # stranger not allow-listed

    def test_first_gameweek_emails_everyone_on_allowlist(self):
        got = sr.choose_recipients(1, 1, self.allow, self.paid, self.engaged)
        self.assertEqual(got, ["a@x.com", "b@x.com", "c@x.com", "d@x.com"])

    def test_later_gameweek_paid_or_engaged_within_allowlist(self):
        got = sr.choose_recipients(5, 1, self.allow, self.paid, self.engaged)
        # b (paid) + c (engaged); d not paid/engaged; stranger not allow-listed
        self.assertEqual(got, ["b@x.com", "c@x.com"])

    def test_case_insensitive_and_deduped(self):
        got = sr.choose_recipients(5, 1, ["B@x.com"], ["b@x.com"], ["B@X.COM"])
        self.assertEqual(got, ["b@x.com"])


class TestDueForReminder(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc)

    def test_due_when_within_24h_and_unsent(self):
        deadline = self.now + timedelta(hours=20)
        self.assertTrue(sr.due_for_reminder(deadline, self.now, set(), 3))

    def test_not_due_when_more_than_24h_away(self):
        deadline = self.now + timedelta(hours=30)
        self.assertFalse(sr.due_for_reminder(deadline, self.now, set(), 3))

    def test_not_due_when_already_sent(self):
        deadline = self.now + timedelta(hours=5)
        self.assertFalse(sr.due_for_reminder(deadline, self.now, {3}, 3))

    def test_not_due_after_deadline_passed(self):
        deadline = self.now - timedelta(hours=1)
        self.assertFalse(sr.due_for_reminder(deadline, self.now, set(), 3))


class TestBuildMessage(unittest.TestCase):
    def test_includes_gameweek_link_and_hours(self):
        deadline = datetime(2026, 8, 21, 18, 30, tzinfo=timezone.utc)
        subject, body = sr.build_message(7, deadline, 22, "https://example.test/")
        self.assertIn("GW7", subject)
        self.assertIn("Gameweek 7", body)
        self.assertIn("https://example.test/", body)
        self.assertIn("22 hours", body)


if __name__ == "__main__":
    unittest.main()
