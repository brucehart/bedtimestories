#!/usr/bin/env python3
import datetime
import json
import os
import sys
import urllib.parse
import urllib.request

DEFAULT_BASE_URL = "https://bedtimestories.bruce-hart.workers.dev"
DEFAULT_RANGE_DAYS = 365


def read_env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError:
        print(f"Invalid {name}: {value}", file=sys.stderr)
        sys.exit(1)
    if parsed < 1:
        print(f"{name} must be >= 1", file=sys.stderr)
        sys.exit(1)
    return parsed


def fetch_calendar_days(base_url: str, start: datetime.date, end: datetime.date, story_token: str) -> set[str]:
    params = urllib.parse.urlencode({
        "start": start.isoformat(),
        "end": end.isoformat(),
    })
    url = f"{base_url}/api/stories/calendar?{params}"
    req = urllib.request.Request(url)
    req.add_header("X-Story-Token", story_token)
    try:
        with urllib.request.urlopen(req) as resp:
            if resp.status != 200:
                body = resp.read().decode("utf-8", "replace")
                raise RuntimeError(f"Calendar request failed ({resp.status}): {body}")
            payload = json.load(resp)
    except Exception as exc:
        raise RuntimeError(f"Calendar request failed: {exc}") from exc

    days = payload.get("days", [])
    return {item.get("day") for item in days if item.get("day")}


def find_next_open_date(base_url: str, story_token: str, range_days: int) -> datetime.date:
    start = datetime.datetime.utcnow().date()
    while True:
        end = start + datetime.timedelta(days=range_days)
        taken = fetch_calendar_days(base_url, start, end, story_token)
        for offset in range((end - start).days + 1):
            candidate = start + datetime.timedelta(days=offset)
            if candidate.isoformat() not in taken:
                return candidate
        start = end + datetime.timedelta(days=1)


def main() -> int:
    story_token = os.getenv("STORY_API_TOKEN")
    if not story_token:
        print("STORY_API_TOKEN is required", file=sys.stderr)
        return 1
    base_url = os.getenv("STORY_API_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    range_days = read_env_int("STORY_CALENDAR_DAYS", DEFAULT_RANGE_DAYS)

    try:
        next_date = find_next_open_date(base_url, story_token, range_days)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(next_date.isoformat())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
