import asyncio
import random
import unittest
from jobqueue import JobQueue


def accounted(q, ids):
    """Each job in exactly one of done / failed / pending."""
    seen = list(q.done) + list(q.failed) + list(q.pending)
    return sorted(seen) == sorted(ids)


class JobQueueTest(unittest.TestCase):
    def test_exactly_once_under_load(self):
        r = random.Random(1)
        delays = {i: r.randint(0, 5) for i in range(300)}
        running = set()
        overlap = []
        calls = []

        async def handler(job_id, payload):
            if job_id in running:
                overlap.append(job_id)
            running.add(job_id)
            calls.append(job_id)
            for _ in range(delays[job_id]):
                await asyncio.sleep(0)
            running.discard(job_id)
            return payload + 1

        q = JobQueue(handler)
        for i in range(300):
            q.submit(i, i * 10)
        asyncio.run(q.run(workers=20))
        self.assertEqual(overlap, [])
        self.assertEqual(sorted(calls), list(range(300)))
        self.assertEqual(q.done, {i: i * 10 + 1 for i in range(300)})
        self.assertEqual(q.attempts, {i: 1 for i in range(300)})
        self.assertEqual((q.failed, q.pending), ({}, []))

    def test_retries_are_per_job(self):
        r = random.Random(2)
        fails = {i: r.choice([0, 0, 1, 2, 3]) for i in range(120)}
        seen = {}
        times = {}

        async def handler(job_id, payload):
            seen[job_id] = seen.get(job_id, 0) + 1
            times.setdefault(job_id, []).append(asyncio.get_running_loop().time())
            await asyncio.sleep(0)
            if seen[job_id] <= fails[job_id]:
                raise RuntimeError(f"boom {job_id} #{seen[job_id]}")
            return "ok"

        q = JobQueue(handler, max_retries=2, backoff=0.02)
        for i in range(120):
            q.submit(i, None)
        asyncio.run(q.run(workers=8))
        self.assertTrue(accounted(q, range(120)))
        self.assertEqual(q.pending, [])
        for i, k in fails.items():
            if k <= 2:
                self.assertEqual(q.done.get(i), "ok", i)
                self.assertEqual(q.attempts[i], k + 1, i)
            else:
                self.assertEqual(q.failed.get(i), f"boom {i} #3", i)
                self.assertEqual(q.attempts[i], 3, i)
            t = times[i]
            for n in range(1, len(t)):
                self.assertGreaterEqual(t[n] - t[n - 1], 0.02 * n - 0.002, (i, t))

    def test_backoff_does_not_hold_workers(self):
        async def handler(job_id, payload):
            if job_id == "slow" and q.attempts["slow"] == 1:
                raise RuntimeError("once")
            await asyncio.sleep(0.01)
            return 1

        q = JobQueue(handler, max_retries=1, backoff=0.5)
        q.submit("slow", None)
        for i in range(40):
            q.submit(i, None)

        async def main():
            loop = asyncio.get_running_loop()
            t = loop.time()
            await q.run(workers=1)
            return loop.time() - t

        took = asyncio.run(main())
        self.assertEqual(len(q.done), 41)
        # 40 jobs x 10 ms run during the 0.5 s backoff; held workers would take ~0.9 s.
        self.assertLess(took, 0.75)

    def test_last_retry_after_others_finish(self):
        async def handler(job_id, payload):
            if job_id == 0 and q.attempts[0] < 3:
                raise RuntimeError("not yet")
            return job_id

        q = JobQueue(handler, max_retries=2, backoff=0.01)
        for i in range(5):
            q.submit(i, None)
        asyncio.run(q.run(workers=5))
        self.assertEqual(q.done, {i: i for i in range(5)})
        self.assertEqual(q.attempts[0], 3)

    def test_stop_keeps_every_job(self):
        r = random.Random(3)
        fails = {i: r.random() < 0.3 for i in range(60)}

        async def handler(job_id, payload):
            await asyncio.sleep(0.01)
            if fails[job_id] and q.attempts[job_id] == 1:
                raise RuntimeError("first try fails")
            return job_id

        q = JobQueue(handler, max_retries=2, backoff=0.05)
        for i in range(60):
            q.submit(i, None)

        async def main():
            task = asyncio.create_task(q.run(workers=6))
            await asyncio.sleep(0.035)
            q.stop()
            await asyncio.wait_for(task, 2)

        asyncio.run(main())
        self.assertTrue(accounted(q, range(60)), (len(q.done), len(q.failed), len(q.pending)))
        self.assertTrue(q.pending, "stop() should leave unstarted jobs pending")
        self.assertEqual(len(set(q.pending)), len(q.pending))
        for i in q.pending:
            self.assertLessEqual(q.attempts.get(i, 0), 1)
        # Resume: everything finishes, nothing runs twice in parallel, attempts keep counting.
        asyncio.run(q.run(workers=6))
        self.assertEqual(q.done, {i: i for i in range(60)})
        self.assertEqual(q.pending, [])
        for i in range(60):
            self.assertEqual(q.attempts[i], 2 if fails[i] else 1, i)
