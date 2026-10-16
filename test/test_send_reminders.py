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


class TestSeasonRecipients(unittest.TestCase):
    def test_only_allowlisted_who_havent_predicted(self):
        allow = ["A@x.com", "b@x.com", "c@x.com"]
        picked = ["b@x.com", "stranger@x.com"]   # stranger not allow-listed
        # a + c haven't predicted; b has; stranger ignored (not allow-listed)
        self.assertEqual(sr.season_recipients(allow, picked), ["a@x.com", "c@x.com"])

    def test_case_insensitive(self):
        self.assertEqual(sr.season_recipients(["B@x.com"], ["b@X.com"]), [])

    def test_nobody_predicted_returns_all(self):
        self.assertEqual(sr.season_recipients(["a@x.com", "b@x.com"], []),
                         ["a@x.com", "b@x.com"])


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


class _FakeSMTP:
    """Stand-in for smtplib.SMTP so connect_smtp() can be tested offline.
    Class-level knobs control how login behaves; `login_modes` records the AUTH
    mechanisms advertised at each login attempt."""
    fail_default = False     # drop the connection on login unless AUTH is forced to LOGIN
    reject = False           # raise a 535 (bad credentials) on every login
    login_modes = []

    def __init__(self, host, port, timeout=None):
        self.esmtp_features = {}

    def ehlo(self):
        self.esmtp_features = {"auth": "PLAIN LOGIN"}   # (re)set by every EHLO, like the real thing
        return (250, b"")

    def starttls(self):
        return (220, b"")

    def login(self, user, password):
        mode = self.esmtp_features.get("auth")
        _FakeSMTP.login_modes.append(mode)
        if _FakeSMTP.reject:
            raise sr.smtplib.SMTPAuthenticationError(535, b"bad credentials")
        if _FakeSMTP.fail_default and mode != "LOGIN":
            raise sr.smtplib.SMTPServerDisconnected("Connection unexpectedly closed")

    def close(self):
        pass


class TestConnectSmtp(unittest.TestCase):
    CFG = ("smtp.example.test", 587, "u", "p", "u@example.test", "Prem Picks")

    def setUp(self):
        self._orig = sr.smtplib.SMTP
        sr.smtplib.SMTP = _FakeSMTP
        _FakeSMTP.fail_default = False
        _FakeSMTP.reject = False
        _FakeSMTP.login_modes = []

    def tearDown(self):
        sr.smtplib.SMTP = self._orig

    def test_normal_login_single_attempt(self):
        sr.connect_smtp(self.CFG)
        self.assertEqual(_FakeSMTP.login_modes, ["PLAIN LOGIN"])

    def test_disconnect_during_auth_retries_once_with_login(self):
        _FakeSMTP.fail_default = True
        sr.connect_smtp(self.CFG)   # succeeds on the forced-LOGIN retry
        self.assertEqual(_FakeSMTP.login_modes, ["PLAIN LOGIN", "LOGIN"])

    def test_rejected_credentials_are_not_retried(self):
        # A 535 must NOT trigger a second login (repeating bad creds risks lockout).
        _FakeSMTP.reject = True
        with self.assertRaises(sr.smtplib.SMTPAuthenticationError):
            sr.connect_smtp(self.CFG)
        self.assertEqual(len(_FakeSMTP.login_modes), 1)


class TestProviderOf(unittest.TestCase):
    def test_labels(self):
        self.assertEqual(sr.provider_of("smtp.gmail.com"), "gmail")
        self.assertEqual(sr.provider_of("smtp-mail.outlook.com"), "outlook")
        self.assertEqual(sr.provider_of("smtp.office365.com"), "outlook")
        self.assertEqual(sr.provider_of("smtp-relay.brevo.com"), "other")
        self.assertEqual(sr.provider_of(None), "other")


if __name__ == "__main__":
    unittest.main()
