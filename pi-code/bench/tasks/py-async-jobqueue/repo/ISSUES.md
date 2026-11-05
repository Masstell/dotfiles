# Bugs reported against JobQueue

- #31 With 20 workers some jobs run twice, and now and then `run()` dies with
  `ValueError: list.remove(x): x not in list`.
- #33 A job failed on its first attempt and was marked failed at once, although `max_retries=2`.
  It only happens when other jobs failed earlier in the same run.
- #36 After `run()` returned, a few jobs were in none of `done`, `failed` or `pending`.
- #40 After `stop()`, some jobs are lost the same way.
