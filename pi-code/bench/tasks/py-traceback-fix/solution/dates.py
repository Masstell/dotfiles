from datetime import datetime, timezone


def parse_ts(s):
    """Parse an ISO 8601 timestamp from the event feed into an aware UTC datetime."""
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)
