"""Project Hermes SessionDB rows into the shape AgentControl consumes.

Owns transcript sanitization for replay-as-conversation, message projection
for the chat UI, and session metadata projection for cost/token displays.
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from hermes_worker_utils import WorkerError, json_safe, string_or_none


AGENT_HISTORY_KEYS = {
    "role",
    "content",
    "tool_calls",
    "tool_call_id",
    "tool_name",
    "finish_reason",
    "reasoning",
    "reasoning_content",
    "reasoning_details",
    "codex_reasoning_items",
    "codex_message_items",
}


def _sanitize_agent_history(history: Any) -> list[dict[str, Any]]:
    if not isinstance(history, list):
        return []
    safe: list[dict[str, Any]] = []
    for item in history:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        if role not in {"user", "assistant", "system", "tool"}:
            continue

        safe_item = {
            key: json_safe(value)
            for key, value in item.items()
            if key in AGENT_HISTORY_KEYS and value is not None
        }
        if not safe_item.get("content") and not safe_item.get("tool_calls") and not safe_item.get("tool_call_id"):
            continue
        safe_item["role"] = role
        safe.append(safe_item)
    return safe


COMPACTION_REFERENCE_PREFIX = "[CONTEXT COMPACTION"
COMPACTION_MARKER_TEXT = "Context compacted. Earlier conversation was summarized so the agent could continue."


def open_session(session_id: str, *, resolve_live: bool = True) -> tuple[Any, str]:
    """Return (session_db, resolved_session_id) for the given session.

    Resolves Hermes compression aliases so chat runs continue from the live
    session tip instead of replaying an old root session.
    """
    # Lazy import so this module has no top-level dependency on hermes_worker.
    # `hermes_worker` aliases itself into sys.modules at startup (see top of
    # `hermes_worker.py`), so this returns the same module instance even when
    # the worker is invoked as a script.
    import hermes_worker

    hermes_worker._ensure_imports()
    if hermes_worker._SessionDB is None:
        raise WorkerError(
            "Hermes session database is unavailable.",
            code="session_db_unavailable",
        )
    db = hermes_worker._SessionDB()
    if not resolve_live:
        return db, session_id
    return db, _resolve_live_session_id(db, session_id)


def _resolve_live_session_id(session_db: Any, session_id: str) -> str:
    compression_tip = getattr(session_db, "get_compression_tip", None)
    if callable(compression_tip):
        try:
            return compression_tip(session_id) or session_id
        except Exception:
            pass

    resolve = getattr(session_db, "resolve_resume_session_id", None)
    if callable(resolve):
        try:
            return resolve(session_id) or session_id
        except Exception:
            return session_id
    return session_id


def _session_lineage_ids(session_db: Any, root_session_id: str) -> list[str]:
    """Return root plus compression child sessions in chronological order."""
    session_ids = [root_session_id]
    db_path = getattr(session_db, "db_path", None)
    if db_path:
        try:
            with sqlite3.connect(str(db_path)) as conn:
                rows = conn.execute(
                    """
                    WITH RECURSIVE lineage(id, started_at, depth) AS (
                      SELECT id, started_at, 0
                      FROM sessions
                      WHERE id = ?
                      UNION ALL
                      SELECT child.id, child.started_at, lineage.depth + 1
                      FROM sessions child
                      JOIN lineage ON child.parent_session_id = lineage.id
                      JOIN sessions parent ON parent.id = lineage.id
                      WHERE lineage.depth < 100
                        AND parent.end_reason = 'compression'
                    )
                    SELECT id
                    FROM lineage
                    ORDER BY started_at, id
                    """,
                    (root_session_id,),
                ).fetchall()
            queried_ids = [str(row[0]) for row in rows if row and row[0]]
            if queried_ids:
                session_ids = queried_ids
        except Exception:
            pass

    # Fallback: if CTE failed or db_path unavailable, resolve via Hermes API
    if len(session_ids) == 1:
        live_session_id = _resolve_live_session_id(session_db, root_session_id)
        if live_session_id != root_session_id:
            session_ids.append(live_session_id)
    return session_ids


def load_agent_history(session_db: Any, session_id: str) -> list[dict[str, Any]]:
    if not session_id:
        return []
    try:
        get_session = getattr(session_db, "get_session", None)
        if callable(get_session) and not get_session(session_id):
            return []
        history = session_db.get_messages_as_conversation(session_id)
    except Exception as exc:
        raise WorkerError(f"Could not load Hermes session history: {exc}", code="session_load_error") from exc
    return _sanitize_agent_history(history)


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if content is None:
        return ""
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                if item:
                    parts.append(item)
                continue
            if isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str) and text:
                    parts.append(text)
                    continue
                item_type = string_or_none(item.get("type"))
                if item_type:
                    parts.append(f"[{item_type}]")
        return "\n".join(parts) if parts else "[non-text content]"
    if isinstance(content, dict):
        text = content.get("text") or content.get("content")
        if isinstance(text, str):
            return text
        return "[non-text content]"
    return str(content)


def _strip_agentcontrol_user_scaffold(content: str) -> str:
    stripped = content.lstrip()
    if stripped.startswith("[TASK AGENT]"):
        marker = "[TASK DESCRIPTION]"
        marker_index = stripped.find(marker)
        if marker_index >= 0:
            return stripped[marker_index + len(marker):].lstrip("\r\n ")

    if stripped.startswith("<task_agent>"):
        marker = "</task_agent>"
        marker_index = stripped.find(marker)
        if marker_index >= 0:
            remainder = stripped[marker_index + len(marker):].lstrip()
            if remainder.startswith("<task_description>"):
                end_marker = "</task_description>"
                end_index = remainder.find(end_marker)
                if end_index >= 0:
                    return remainder[len("<task_description>"):end_index].strip()
            return remainder

    return content


def _is_compaction_reference(content: str) -> bool:
    stripped = content.lstrip()
    return (
        stripped.startswith(COMPACTION_REFERENCE_PREFIX)
        and "REFERENCE ONLY" in stripped[:200]
    )


def _timestamp_to_ms(timestamp: Any) -> int:
    try:
        value = float(timestamp)
    except (TypeError, ValueError):
        return int(time.time() * 1000)
    if value < 10_000_000_000:
        value *= 1000
    return int(value)


def _thinking_to_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value or None
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)


def project_session_messages(session_id: Any, task_id: Any = None) -> dict[str, Any]:
    session_id = string_or_none(session_id)
    if not session_id:
        raise WorkerError("Session ID is required.", code="bad_request")

    session_db, root_session_id = open_session(session_id, resolve_live=False)
    projected: list[dict[str, Any]] = []
    projected_task_id = string_or_none(task_id) or session_id

    for lineage_index, lineage_session_id in enumerate(_session_lineage_ids(session_db, root_session_id)):
        try:
            rows = session_db.get_messages(lineage_session_id)
        except Exception as exc:
            raise WorkerError(f"Could not load Hermes session messages: {exc}", code="session_load_error") from exc

        is_root_session = lineage_index == 0
        compaction_seen = is_root_session
        child_user_seen = is_root_session

        for row in rows:
            if not isinstance(row, dict):
                row = dict(row)
            role = row.get("role")
            if role not in {"user", "assistant"}:
                continue

            content = _content_to_text(row.get("content"))
            if role == "user":
                content = _strip_agentcontrol_user_scaffold(content)
                if _is_compaction_reference(content):
                    projected.append({
                        "id": f"hermes:{lineage_session_id}:compaction:{row.get('id')}",
                        "task_id": projected_task_id,
                        "role": "system",
                        "content": COMPACTION_MARKER_TEXT,
                        "created_at": _timestamp_to_ms(row.get("timestamp")),
                    })
                    compaction_seen = True
                    child_user_seen = False
                    continue
                if not compaction_seen:
                    continue
                child_user_seen = True
            elif not compaction_seen or not child_user_seen:
                continue

            if role == "assistant" and not content.strip() and row.get("tool_calls"):
                continue
            if not content.strip():
                continue

            message = {
                "id": f"hermes:{lineage_session_id}:{row.get('id')}",
                "task_id": projected_task_id,
                "role": role,
                "content": content,
                "created_at": _timestamp_to_ms(row.get("timestamp")),
            }
            if role == "assistant":
                thinking = (
                    _thinking_to_text(row.get("reasoning_content"))
                    or _thinking_to_text(row.get("reasoning"))
                    or _thinking_to_text(row.get("reasoning_details"))
                    or _thinking_to_text(row.get("codex_reasoning_items"))
                )
                if thinking:
                    message["thinking"] = thinking
            projected.append(message)

    return {"messages": projected}


def _int_field(row: dict[str, Any], key: str) -> int:
    try:
        return int(row.get(key) or 0)
    except Exception:
        return 0


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except Exception:
        return None


def project_session_metadata(session_id: Any) -> dict[str, Any]:
    session_id = string_or_none(session_id)
    if not session_id:
        raise WorkerError("Session ID is required.", code="bad_request")

    session_db, live_session_id = open_session(session_id)
    try:
        row = session_db.get_session(live_session_id)
    except Exception as exc:
        raise WorkerError(f"Could not load Hermes session metadata: {exc}", code="session_load_error") from exc

    if not row:
        return {"session": None}

    return {
        "session": {
            "id": str(row.get("id") or live_session_id),
            "input_tokens": _int_field(row, "input_tokens"),
            "output_tokens": _int_field(row, "output_tokens"),
            "cache_read_tokens": _int_field(row, "cache_read_tokens"),
            "cache_write_tokens": _int_field(row, "cache_write_tokens"),
            "reasoning_tokens": _int_field(row, "reasoning_tokens"),
            "estimated_cost_usd": _float_or_none(row.get("estimated_cost_usd")),
            "cost_status": string_or_none(row.get("cost_status")) or "unknown",
            "model": string_or_none(row.get("model")),
        }
    }
