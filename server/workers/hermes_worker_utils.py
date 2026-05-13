"""Shared utilities for the Hermes worker and its submodules.

Kept intentionally small: just the error type and pure helpers that are used
across `hermes_worker.py`, `hermes_sessions.py`, and `hermes_cron.py`.
"""

from __future__ import annotations

from typing import Any


class WorkerError(Exception):
    def __init__(self, message: str, code: str = "worker_error", hint: str | None = None):
        super().__init__(message)
        self.code = code
        self.hint = hint


def string_or_none(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): json_safe(val) for key, val in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(item) for item in value]
    return str(value)


def truncate_with_ellipsis(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."
