from datetime import datetime, timezone


def parse_ts(s):
    """Parse an ISO 8601 timestamp from the event feed into an aware UTC datetime."""
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
