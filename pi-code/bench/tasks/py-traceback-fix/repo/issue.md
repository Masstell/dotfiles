# Event import crashes

Since the feed provider changed format last night the importer dies on every batch:

```
Traceback (most recent call last):
  File "/srv/importer/run.py", line 41, in <module>
    ts = parse_ts(event["at"])
  File "/srv/importer/dates.py", line 6, in parse_ts
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
ValueError: unconverted data remains: Z
```

Example values from the feed: `2026-11-05T10:00:00Z`, `2026-11-05T12:00:00+02:00`,
`2026-11-05T10:00:00.250Z`, and old-style `2026-11-05T10:00:00`.
