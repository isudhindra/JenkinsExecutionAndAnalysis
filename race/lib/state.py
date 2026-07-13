"""In-memory state for the dashboard — latest fetch's job_store and the
SSE operation_id. All reads/writes go through helpers so concurrent SSE
writers and refresh readers can't tear the dict, and keys are normalised
so callers can use either trailing-slash form interchangeably.
"""

import threading
from typing import Dict, Optional

from race.models import JobRecord

# Reset on every full fetch; selectively updated on refresh.
job_store: Dict[str, JobRecord] = {}

# Guards every job_store mutation and iteration.
job_store_lock = threading.RLock()


def _key(job_url: str) -> str:
    """Single normalisation rule for store keys — strips trailing slash so a
    request body's 'http://x/job/foo' matches a Jenkins-emitted 'http://x/job/foo/'.
    """
    return (job_url or "").rstrip("/")


def job_store_snapshot() -> Dict[str, JobRecord]:
    """Return a shallow copy of job_store under lock — safe to iterate."""
    with job_store_lock:
        return dict(job_store)


def job_store_set(job_url: str, record: JobRecord) -> None:
    """Insert or update a single job under lock (key normalised)."""
    with job_store_lock:
        job_store[_key(job_url)] = record


def job_store_get(job_url: str) -> Optional[JobRecord]:
    """Read a single job under lock (key normalised)."""
    with job_store_lock:
        return job_store.get(_key(job_url))


def job_store_clear() -> None:
    """Drop every job under lock — called at the start of a full fetch."""
    with job_store_lock:
        job_store.clear()


# Empty when idle. Stale events whose operation_id doesn't match this are ignored.
active_operation_id: str = ""
