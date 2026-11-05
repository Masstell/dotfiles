import asyncio


class JobQueue:
    """Runs async jobs with a pool of workers.

    submit(job_id, payload) queues a job (ids are unique). await run(workers) starts `workers` workers
    and returns when every submitted job is done or has failed for good, or, after stop(), as soon as
    the workers have finished the attempts they were running. run() may be called again later; it
    forgets any earlier stop().

    Each job is handled by `await handler(job_id, payload)`; one worker runs one attempt at a time and
    no job ever has two attempts running at once. If the handler raises an Exception, the job is
    retried up to max_retries more times; before retry n (n = 1, 2, ...) it waits backoff * n seconds,
    without holding up a worker meanwhile. After stop(), a failed attempt with retries left puts the
    job back in pending instead of retrying it now.

    When run() returns, every submitted job is in exactly one of:
      done     {job_id: handler result}
      failed   {job_id: str(last exception)}   (after 1 + max_retries attempts)
      pending  [job_id, ...]                   (not finished; only after stop())
    and attempts[job_id] is how many times the handler was called for it.
    """

    def __init__(self, handler, max_retries=2, backoff=0.01):
        self.handler = handler
        self.max_retries = max_retries
        self.backoff = backoff
        self.pending = []
        self.payloads = {}
        self.done = {}
        self.failed = {}
        self.attempts = {}
        self._retries = 0
        self._stopping = False

    def submit(self, job_id, payload):
        self.pending.append(job_id)
        self.payloads[job_id] = payload

    async def _load(self, job_id):
        await asyncio.sleep(0)  # payloads come from storage in production
        return self.payloads[job_id]

    async def _worker(self):
        loop = asyncio.get_running_loop()
        while not self._stopping and self.pending:
            job_id = self.pending[0]
            payload = await self._load(job_id)
            self.pending.remove(job_id)
            self.attempts[job_id] = self.attempts.get(job_id, 0) + 1
            try:
                self.done[job_id] = await self.handler(job_id, payload)
            except Exception as e:
                self._retries += 1
                if self._retries <= self.max_retries:
                    loop.call_later(self.backoff * self._retries, self.pending.append, job_id)
                else:
                    self.failed[job_id] = str(e)

    async def run(self, workers=4):
        self._stopping = False
        await asyncio.gather(*(self._worker() for _ in range(workers)))

    def stop(self):
        self._stopping = True
