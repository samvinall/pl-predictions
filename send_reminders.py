"""
Deadline reminder emails.
=========================

Sends a short "make your pick" email ~24 hours before each gameweek's
deadline. Designed to run on a schedule (see .github/workflows/reminders.yml)
alongside the data sync.

Who gets emailed:
  * Before the FIRST gameweek of the season: everyone on the guest list
    (config/allowlist).
  * From then on: anyone who has PAID (config/paid) OR ENGAGED -- i.e. made a
    pick in any past gameweek. Only ever emails allow-listed addresses.

Sending is plain SMTP, configured entirely by environment variables / secrets,
so the same code works with Gmail, Outlook/Hotmail, or any transactional
provider's SMTP endpoint (Resend/SendGrid/...) -- just change the secrets:
  SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS,
  FROM_EMAIL (default = SMTP_USER), FROM_NAME (default "Prem Picks"),
  SITE_URL (default the live GitHub Pages URL).
If the SMTP secrets aren't set, this no-ops (so it's safe to enable before
you've added them).

Dedupe: the gameweeks already reminded are recorded in config/reminders, so a
2-hourly schedule never double-sends.
"""

import os
import sys
import smtplib
from datetime import datetime, timezone, timedelta
from email.message import EmailMessage

# Reuse the same Firestore connection helper as the other scripts.
from pull_results import get_db

REMIND_WITHIN = timedelta(hours=24)
DEFAULT_SITE_URL = "https://samvinall.github.io/pl-predictions/"


# --- Pure helpers (unit-tested) --------------------------------------------

def choose_recipients(target_gw, first_gw, allow, paid, engaged):
    """The set of emails to remind for `target_gw`. The first gameweek goes to
    everyone on the guest list; after that, to paid OR engaged players, always
    intersected with the guest list. Returns a sorted, lower-cased list."""
    allow = {e.lower() for e in allow if e}
    if target_gw == first_gw:
        chosen = allow
    else:
        pool = {e.lower() for e in paid if e} | {e.lower() for e in engaged if e}
        chosen = allow & pool
    return sorted(chosen)


def due_for_reminder(deadline, now, sent_gws, gw, within=REMIND_WITHIN):
    """True if `gw` hasn't been reminded yet and its deadline is within the next
    `within` (and still in the future) -- i.e. it's time to send the ~24h nudge."""
    if gw in sent_gws:
        return False
    remaining = deadline - now
    return timedelta(0) < remaining <= within


def build_message(gw, deadline, hours_left, site_url):
    """The reminder's subject + plain-text body."""
    subject = f"⚽ Prem Picks — GW{gw} locks in ~{hours_left}h"
    body = (
        f"Your Prem Picks pick for Gameweek {gw} is due soon.\n\n"
        f"Deadline: {deadline.strftime('%a %d %b %Y, %H:%M UTC')} "
        f"(about {hours_left} hours away).\n\n"
        f"Make or change your pick here:\n{site_url}\n\n"
        f"Good luck!\n\n"
        f"— Prem Picks\n"
        f"(You're getting this because you're in the league. Reply to opt out.)"
    )
    return subject, body


# --- Data + sending --------------------------------------------------------

def _doc(db, name):
    return db.collection("config").document(name).get().to_dict() or {}


def send_emails(cfg, recipients, subject, body):
    """Send one message to each recipient over SMTP. `cfg` is
    (host, port, user, password, from_email, from_name). Returns how many
    were sent OK; a single bad address doesn't stop the rest."""
    host, port, user, password, from_email, from_name = cfg
    sent_ok = 0
    with smtplib.SMTP(host, port) as server:
        server.starttls()
        server.login(user, password)
        for to in recipients:
            msg = EmailMessage()
            msg["Subject"] = subject
            msg["From"] = f"{from_name} <{from_email}>"
            msg["To"] = to
            msg.set_content(body)
            try:
                server.send_message(msg)
                sent_ok += 1
            except Exception as e:
                print(f"  ✗ {to}: {e}")
    return sent_ok


def main():
    host = os.environ.get("SMTP_HOST")
    user = os.environ.get("SMTP_USER")
    # Strip all whitespace: Gmail/Outlook show app passwords grouped with spaces
    # ("abcd efgh ijkl mnop") and pasting those spaces is a common cause of a
    # 535 "Username and Password not accepted" error.
    password = "".join((os.environ.get("SMTP_PASS") or "").split())
    if not (host and user and password):
        print("ℹ️  SMTP not configured (SMTP_HOST / SMTP_USER / SMTP_PASS) — "
              "skipping reminders.")
        return
    port = int(os.environ.get("SMTP_PORT", "587"))
    from_email = os.environ.get("FROM_EMAIL", user)
    from_name = os.environ.get("FROM_NAME", "Prem Picks")
    site_url = os.environ.get("SITE_URL", DEFAULT_SITE_URL)
    cfg = (host, port, user, password, from_email, from_name)

    # TEST MODE: send a single sample email to one address and stop. Set via the
    # workflow's `test_to` input (TEST_TO env). Bypasses the deadline window,
    # recipient list and dedupe -- purely for checking delivery/formatting.
    test_to = os.environ.get("TEST_TO", "").strip()
    if test_to:
        subject = "⚽ Prem Picks — test reminder"
        body = (
            "This is a test of the Prem Picks deadline reminder emails.\n\n"
            "When a gameweek deadline is ~24h away, players get a nudge with a "
            f"link to make their pick:\n{site_url}\n\n"
            "If this landed in your inbox (not spam), you're good to go.\n\n"
            "— Prem Picks"
        )
        n = send_emails(cfg, [test_to], subject, body)
        print(f"✅ Test email: sent {n}/1 to {test_to}.")
        return

    db = get_db()
    current = _doc(db, "current")
    schedule = _doc(db, "schedule")
    if not current or not schedule:
        print("No current gameweek / schedule yet — nothing to remind.")
        return

    gw = current.get("gameweek")
    deadlines = schedule.get("deadlines", {})
    deadline = deadlines.get(str(gw))
    if deadline is None:
        print(f"No deadline recorded for GW{gw} — nothing to do.")
        return

    now = datetime.now(timezone.utc)
    sent = set(_doc(db, "reminders").get("sent", []))
    if not due_for_reminder(deadline, now, sent, gw):
        remaining = deadline - now
        print(f"GW{gw}: {remaining} to deadline, already_sent={gw in sent} — "
              f"no reminder due.")
        return

    first_gw = min(int(k) for k in deadlines)
    allow = _doc(db, "allowlist").get("emails", [])
    paid = _doc(db, "paid").get("emails", [])
    engaged = set()
    for d in db.collection("picks").stream():
        email = (d.to_dict().get("email") or "").lower()
        if email:
            engaged.add(email)

    recipients = choose_recipients(gw, first_gw, allow, paid, engaged)
    if not recipients:
        print(f"GW{gw}: no recipients to email.")
        return

    hours_left = int((deadline - now).total_seconds() // 3600)
    subject, body = build_message(gw, deadline, hours_left, site_url)

    sent_ok = send_emails(cfg, recipients, subject, body)
    print(f"✅ Sent {sent_ok}/{len(recipients)} GW{gw} reminders.")

    if sent_ok:
        db.collection("config").document("reminders").set(
            {"sent": sorted(sent | {gw})}, merge=True)


if __name__ == "__main__":
    main()
