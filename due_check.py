#!/usr/bin/env python3
"""Print due=true/false: does tonight's scheduled run have anything to book?

Standard library only, so the workflow can run it before installing Python
dependencies and Chromium. Nights with nothing queued then finish in seconds
instead of using several Actions minutes.
"""

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).parent
BOOKINGS_FILE = ROOT / "bookings.json"
SETTINGS_FILE = ROOT / "data" / "settings.json"


def booking_target_date(now: datetime) -> date:
    # Mirrors run_scheduled.py: a run started during the 23:00 hour waits for
    # midnight, so its target is the day after tomorrow.
    days = 2 if now.hour == 23 else 1
    return now.date() + timedelta(days=days)


def is_due(entry: dict, target: date) -> bool:
    if entry.get("status") != "pending":
        return False
    try:
        return date.fromisoformat(entry.get("date", "")) <= target
    except (TypeError, ValueError):
        return True  # let run_scheduled.py mark it invalid


def main() -> None:
    tz = json.loads(SETTINGS_FILE.read_text())["timezone"]
    target = booking_target_date(datetime.now(tz=ZoneInfo(tz)))

    bookings = json.loads(BOOKINGS_FILE.read_text()) if BOOKINGS_FILE.exists() else []
    due = isinstance(bookings, list) and any(isinstance(b, dict) and is_due(b, target) for b in bookings)

    print(f"Target date {target.isoformat()}: {'bookings due' if due else 'nothing due'}.", file=sys.stderr)
    print(f"due={'true' if due else 'false'}")


if __name__ == "__main__":
    main()
