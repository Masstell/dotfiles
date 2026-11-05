import asyncio
import unittest
from jobqueue import JobQueue


class JobQueueTest(unittest.TestCase):
    def test_simple(self):
        async def handler(job_id, payload):
            return payload * 2

        q = JobQueue(handler)
        for i in range(5):
            q.submit(i, i)
        asyncio.run(q.run(workers=2))
        self.assertEqual(q.done, {i: i * 2 for i in range(5)})
