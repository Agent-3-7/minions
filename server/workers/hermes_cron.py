"""Cron job operations and run-output projection for the Hermes worker.

Wraps Hermes's `cron.jobs` / `cron.scheduler` modules with input validation,
shape normalization, and a background ticker thread.
"""

from __future__ import annotations

import stat
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from hermes_worker_utils import (
    WorkerError,
    json_safe,
    string_or_none,
    truncate_with_ellipsis,
)


_CRON_TICKER_STARTED = False
_CRON_TICKER_LOCK = threading.Lock()


def _ensure_imports() -> None:
    # Lazy import so this module does not need a top-level dep on hermes_worker.
    # `hermes_worker._ensure_imports()` adds the Hermes agent dir to sys.path,
    # making `cron.jobs` / `cron.scheduler` importable below.
    import hermes_worker

    hermes_worker._ensure_imports()


def _normalize_cron_job(job: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(job, dict):
        return None

    job_id = string_or_none(job.get("id")) or ""
    raw_schedule = job.get("schedule")
    raw_origin = job.get("origin")
    raw_skills = job.get("skills")
    if raw_skills is None and job.get("skill"):
        raw_skills = [job.get("skill")]

    return {
        "id": job_id,
        "name": string_or_none(job.get("name")) or job_id,
        "prompt": string_or_none(job.get("prompt")),
        "schedule": json_safe(raw_schedule) if isinstance(raw_schedule, dict) else None,
        "scheduleDisplay": string_or_none(job.get("schedule_display")),
        "enabled": bool(job.get("enabled", True)),
        "state": string_or_none(job.get("state")),
        "nextRunAt": string_or_none(job.get("next_run_at")),
        "lastRunAt": string_or_none(job.get("last_run_at")),
        "lastStatus": string_or_none(job.get("last_status")),
        "lastError": string_or_none(job.get("last_error")),
        "lastDeliveryError": string_or_none(job.get("last_delivery_error")),
        "model": string_or_none(job.get("model")),
        "provider": string_or_none(job.get("provider")),
        "baseUrl": string_or_none(job.get("base_url")),
        "deliver": string_or_none(job.get("deliver")),
        "origin": json_safe(raw_origin) if isinstance(raw_origin, dict) else None,
        "skills": [str(item) for item in raw_skills] if isinstance(raw_skills, list) else [],
        "createdAt": string_or_none(job.get("created_at")),
    }


def _validate_path_segment(value: Any, label: str) -> str:
    raw = string_or_none(value)
    if not raw:
        raise WorkerError(f"{label} is required.", code="bad_request")
    if "/" in raw or "\\" in raw or ".." in raw:
        raise WorkerError(f"Invalid {label}.", code="bad_request")
    return raw


def list_cron_jobs(include_disabled: bool = False) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import list_jobs

    jobs = [_normalize_cron_job(job) for job in list_jobs(include_disabled=include_disabled)]
    return {"jobs": [job for job in jobs if job is not None]}


def get_cron_job(job_id: Any) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import get_job

    job = _normalize_cron_job(get_job(_validate_path_segment(job_id, "Cron job ID")))
    return {"job": job}


def pause_cron_job(job_id: Any, reason: Any = None) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import pause_job

    raw_reason = string_or_none(reason)
    job = _normalize_cron_job(pause_job(_validate_path_segment(job_id, "Cron job ID"), reason=raw_reason))
    return {"job": job}


def resume_cron_job(job_id: Any) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import resume_job

    job = _normalize_cron_job(resume_job(_validate_path_segment(job_id, "Cron job ID")))
    return {"job": job}


def trigger_cron_job(job_id: Any) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import trigger_job

    job = _normalize_cron_job(trigger_job(_validate_path_segment(job_id, "Cron job ID")))
    return {"job": job}


def remove_cron_job(job_id: Any) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import remove_job

    removed = bool(remove_job(_validate_path_segment(job_id, "Cron job ID")))
    return {"ok": removed}


def _run_preview(content: str, max_chars: int = 420) -> str:
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    return truncate_with_ellipsis("\n".join(lines[:6]), max_chars)


def _run_timestamp_from_stem(stem: str) -> str | None:
    try:
        return datetime.strptime(stem, "%Y-%m-%d_%H-%M-%S").isoformat()
    except ValueError:
        return None


def _cron_run_status(content: str) -> str:
    first_line = next((line.strip() for line in content.splitlines() if line.strip()), "")
    if first_line.startswith("# Cron Job:") and "(FAILED)" in first_line:
        return "error"
    if first_line.startswith("# Cron Job:"):
        return "ok"
    return "unknown"


def _read_run_head(path: Path, max_bytes: int = 2048) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(max_bytes)
    except OSError:
        return ""


def list_cron_runs(job_id: Any, limit: Any = 20) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import OUTPUT_DIR

    cron_job_id = _validate_path_segment(job_id, "Cron job ID")
    try:
        parsed_limit = int(limit)
    except (TypeError, ValueError):
        parsed_limit = 20
    parsed_limit = max(1, min(parsed_limit, 100))

    output_dir = Path(OUTPUT_DIR) / cron_job_id
    entries: list[tuple[float, Path]] = []
    for path in output_dir.glob("*.md"):
        try:
            st = path.stat()
        except OSError:
            continue
        if not stat.S_ISREG(st.st_mode):
            continue
        entries.append((st.st_mtime, path))
    entries.sort(key=lambda entry: (entry[0], entry[1].name), reverse=True)

    runs: list[dict[str, Any]] = []
    for _, path in entries[:parsed_limit]:
        head = _read_run_head(path)
        runs.append({
            "id": path.stem,
            "jobId": cron_job_id,
            "ranAt": _run_timestamp_from_stem(path.stem),
            "path": str(path),
            "status": _cron_run_status(head),
            "preview": _run_preview(head),
        })

    return {"runs": runs}


def get_cron_run_content(job_id: Any, run_id: Any) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import OUTPUT_DIR

    cron_job_id = _validate_path_segment(job_id, "Cron job ID")
    raw_run_id = _validate_path_segment(run_id, "Run ID")

    path = Path(OUTPUT_DIR) / cron_job_id / f"{raw_run_id}.md"
    if not path.is_file():
        raise WorkerError("Cron run output not found.", code="not_found")

    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = path.read_text(encoding="utf-8", errors="replace")

    return {"content": content}


def tick_cron() -> int:
    _ensure_imports()
    from cron.scheduler import tick

    return int(tick(verbose=False) or 0)


def _cron_ticker_loop() -> None:
    while True:
        try:
            executed = tick_cron()
            if executed:
                print(f"[hermes-worker] cron tick executed {executed} job(s)", file=sys.stderr, flush=True)
        except Exception as exc:
            print(f"[hermes-worker] cron tick failed: {exc}", file=sys.stderr, flush=True)
        time.sleep(60)


def start_cron_ticker() -> None:
    global _CRON_TICKER_STARTED
    with _CRON_TICKER_LOCK:
        if _CRON_TICKER_STARTED:
            return
        thread = threading.Thread(target=_cron_ticker_loop, name="hermes-cron-ticker", daemon=True)
        thread.start()
        _CRON_TICKER_STARTED = True
