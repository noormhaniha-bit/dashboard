"""Runs the FullStory session-recording automation (automation/fullstory, a Playwright/Node
script) as a subprocess over a batch of applicationIds, and tracks its progress so the dashboard
can poll it.

The automation drives a real, visible Chrome window against app.fullstory.com using a saved
login session (automation/fullstory/playwright/.auth/user.json) -- it is not something that can
run headless inside a request/response cycle, and only one can sensibly run at a time on this
machine (one shared auth state, one visible browser). The node script itself already loops over
however many applicationIds are in its input file within a single run, so one job = one batch,
not one job per id. Jobs are tracked in memory only: this is a single-process app and job
history doesn't need to survive a restart.
"""

import asyncio
import json
import logging
import re
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from app.config import FULLSTORY_AUTOMATION_DIR, FULLSTORY_NODE_BIN

logger = logging.getLogger(__name__)

# Keep only the most recent lines in memory per job -- the node process prints a progress
# line every couple seconds per recording, which would otherwise grow unbounded over a
# long-running multi-session job.
_MAX_LOG_LINES = 4000
_MAX_JOBS_KEPT = 30


class FullStoryAutomationNotFound(Exception):
    pass


class JobAlreadyRunning(Exception):
    def __init__(self, job: "Job"):
        ids = job.application_ids
        preview = ", ".join(ids[:3]) + (f" +{len(ids) - 3} more" if len(ids) > 3 else "")
        super().__init__(f"A recording job is already running (job {job.id}, {len(ids)} applicationId(s): {preview})")
        self.job = job


def parse_application_ids(raw: str) -> list[str]:
    """Parses free-form applicationId input -- a JSON array/object (matching what the node
    script's own --file loader accepts), or a plain list of ids separated by commas and/or
    newlines (for pasting straight into the textarea)."""
    raw = raw.strip()
    if not raw:
        return []

    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(v).strip() for v in parsed if str(v).strip()]
        if isinstance(parsed, dict):
            return [str(v).strip() for v in parsed.values() if str(v).strip()]
        return [str(parsed).strip()]
    except (json.JSONDecodeError, ValueError):
        pass

    return [p.strip() for p in re.split(r"[,\r\n]+", raw) if p.strip()]


def dedupe(ids: list[str]) -> list[str]:
    seen: set[str] = set()
    out = []
    for i in ids:
        if i and i not in seen:
            seen.add(i)
            out.append(i)
    return out


@dataclass
class Job:
    id: str
    application_ids: list[str]
    requested_by: str
    status: str = "queued"  # queued -> running -> success | failed
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    return_code: int | None = None
    log: list[str] = field(default_factory=list)

    def append_log(self, line: str) -> None:
        self.log.append(line)
        if len(self.log) > _MAX_LOG_LINES:
            del self.log[: len(self.log) - _MAX_LOG_LINES]

    def to_dict(self, include_log: bool = False) -> dict:
        out = {
            "id": self.id,
            "application_ids": self.application_ids,
            "requested_by": self.requested_by,
            "status": self.status,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "return_code": self.return_code,
        }
        if include_log:
            out["log"] = self.log
        return out


_jobs: dict[str, Job] = {}
_current_job_id: str | None = None
_lock = asyncio.Lock()


def get_job(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def list_jobs() -> list[Job]:
    return sorted(_jobs.values(), key=lambda j: j.created_at, reverse=True)


async def start_job(application_ids: list[str], requested_by: str) -> Job:
    global _current_job_id

    if not application_ids:
        raise ValueError("application_ids must not be empty")

    if not FULLSTORY_AUTOMATION_DIR.exists():
        raise FullStoryAutomationNotFound(
            f"FullStory automation not found at '{FULLSTORY_AUTOMATION_DIR}'."
        )

    async with _lock:
        current = _jobs.get(_current_job_id) if _current_job_id else None
        if current and current.status in ("queued", "running"):
            raise JobAlreadyRunning(current)

        job = Job(id=uuid.uuid4().hex[:12], application_ids=application_ids, requested_by=requested_by)
        _jobs[job.id] = job
        _current_job_id = job.id

        # Trim old finished jobs so the in-memory list doesn't grow forever across a long
        # uptime -- keep the most recent N regardless of status.
        if len(_jobs) > _MAX_JOBS_KEPT:
            for old_id in [j.id for j in list_jobs()[_MAX_JOBS_KEPT:]]:
                _jobs.pop(old_id, None)

    asyncio.create_task(_run_job(job))
    return job


async def _run_job(job: Job) -> None:
    global _current_job_id

    input_fd, input_path_str = tempfile.mkstemp(prefix="fullstory_input_", suffix=".json")
    input_path = Path(input_path_str)
    try:
        with open(input_fd, "w", encoding="utf-8") as f:
            json.dump(job.application_ids, f)

        job.status = "running"
        job.started_at = time.time()
        job.append_log(f"$ node index.js --file {input_path.name}  ({len(job.application_ids)} applicationId(s))")

        try:
            proc = await asyncio.create_subprocess_exec(
                FULLSTORY_NODE_BIN, "index.js", "--file", str(input_path),
                cwd=str(FULLSTORY_AUTOMATION_DIR),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except FileNotFoundError as e:
            job.append_log(f"Failed to launch node: {e}")
            job.status = "failed"
            job.finished_at = time.time()
            return

        assert proc.stdout is not None
        async for raw_line in proc.stdout:
            line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
            if line:
                job.append_log(line)

        job.return_code = await proc.wait()
        job.status = "success" if job.return_code == 0 else "failed"
        job.finished_at = time.time()
    except Exception as e:
        logger.exception("FullStory job %s crashed", job.id)
        job.append_log(f"Internal error: {e}")
        job.status = "failed"
        job.finished_at = time.time()
    finally:
        input_path.unlink(missing_ok=True)
        if _current_job_id == job.id:
            _current_job_id = None
