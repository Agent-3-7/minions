#!/usr/bin/env python3
"""JSONL bridge between Minions and Hermes AIAgent."""

from __future__ import annotations

import argparse
import dataclasses
import inspect
import json
import os
import re
import sys
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from pathlib import Path
from typing import Any, Callable

# Alias so submodules importing `hermes_worker` see this module even when run as `__main__`.
sys.modules.setdefault("hermes_worker", sys.modules[__name__])

from hermes_worker_utils import (
    WorkerError,
    string_or_none,
    truncate_with_ellipsis,
)
from hermes_sessions import (
    load_agent_history,
    open_session,
    project_session_messages,
    project_session_metadata,
)
from hermes_cron import (
    get_cron_job,
    get_cron_run_content,
    list_cron_jobs,
    list_cron_runs,
    pause_cron_job,
    remove_cron_job,
    resume_cron_job,
    start_cron_ticker,
    tick_cron,
    trigger_cron_job,
)

PROTOCOL_OUT = sys.stdout
PROTOCOL_LOCK = threading.Lock()

# Cap on concurrent AIAgent.run_conversation calls (chat + judge).
AGENT_RUN_LIMIT = int(os.environ.get("HERMES_AGENT_RUN_LIMIT", "10"))
AGENT_SEMAPHORE = threading.BoundedSemaphore(AGENT_RUN_LIMIT)
ACTIVE_TASKS: dict[str, str] = {}
ACTIVE_TASKS_LOCK = threading.Lock()

ALLOWED_REASONING = {"none", "minimal", "low", "medium", "high", "xhigh"}
KNOWN_PROVIDER_PREFIXES = {
    "anthropic",
    "openai",
    "openai-codex",
    "copilot",
    "deepseek",
    "gemini",
    "google",
    "kimi",
    "kimi-coding",
    "minimax",
    "mistral",
    "mistralai",
    "moonshotai",
    "nous",
    "ollama",
    "ollama-cloud",
    "openrouter",
    "qwen",
    "x-ai",
    "xai",
    "z-ai",
    "zai",
}

_AGENT_DIR: Path | None = None
_IMPORTS_READY = False
_IMPORTS_LOCK = threading.Lock()
_AIAgent: Any = None
_AIAgent_PARAMS: set[str] = set()
_SessionDB: Any = None
_CONFIG_CACHE: dict[str, Any] | None = None
_CONFIG_MTIME: float = 0.0
_MODEL_EXECUTOR = ThreadPoolExecutor(max_workers=1)
try:
    _MODEL_LIST_CACHE_TTL_SECONDS = max(0.0, float(os.environ.get("MINIONS_MODEL_LIST_CACHE_TTL_SECONDS", "60")))
except ValueError:
    _MODEL_LIST_CACHE_TTL_SECONDS = 60.0


@dataclasses.dataclass
class _ModelListCache:
    data: dict[str, Any]
    config_mtime: float
    expires_at: float


_MODEL_LIST_CACHE: _ModelListCache | None = None
_MODEL_LIST_CACHE_LOCK = threading.Lock()


def _send(payload: dict[str, Any]) -> None:
    with PROTOCOL_LOCK:
        PROTOCOL_OUT.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        PROTOCOL_OUT.flush()


def _result(request_id: str, data: dict[str, Any]) -> None:
    _send({"id": request_id, "type": "result", "data": data})


def _error_payload(exc: BaseException) -> dict[str, str]:
    if isinstance(exc, WorkerError):
        payload = {"message": str(exc), "code": exc.code}
        if exc.hint:
            payload["hint"] = exc.hint
        return payload

    message = str(exc) or exc.__class__.__name__
    lower = message.lower()
    code = "worker_error"
    hint = None

    if isinstance(exc, ImportError) or "no module named" in lower:
        code = "import_error"
        hint = "Use HERMES_PYTHON=~/.hermes/hermes-agent/venv/bin/python."
    elif "unauthorized" in lower or "authentication" in lower or "401" in lower or "api key" in lower:
        code = "auth_error"
        hint = "Run hermes model or update ~/.hermes/config.yaml credentials."
    elif "rate limit" in lower or "429" in lower:
        code = "rate_limit"
        hint = "Retry later or switch provider/model."
    elif "quota" in lower or "credit" in lower or "insufficient" in lower:
        code = "quota_exhausted"
        hint = "Top up provider account or switch provider/model."
    elif "model" in lower and ("not found" in lower or "rejected" in lower or "invalid" in lower):
        code = "model_error"
        hint = "Pick another model from the model menu."

    payload = {"message": message, "code": code}
    if hint:
        payload["hint"] = hint
    return payload


def _send_error(request_id: str, exc: BaseException) -> None:
    _send({"id": request_id, "type": "error", "error": _error_payload(exc)})


def _resolve_agent_dir_from_hermes_cli() -> Path | None:
    import shutil

    hermes_bin = shutil.which("hermes")
    if not hermes_bin:
        return None
    try:
        real = Path(hermes_bin).resolve()
        # Typical layout: <agent-dir>/venv/bin/hermes
        candidate = real.parent.parent.parent
        if (candidate / "run_agent.py").exists():
            return candidate
    except OSError:
        pass
    return None


def _discover_agent_dir() -> Path:
    candidates: list[Path] = []

    env_dir = os.environ.get("HERMES_AGENT_DIR", "").strip()
    if env_dir:
        candidates.append(Path(env_dir).expanduser())

    hermes_home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()
    candidates.append(hermes_home / "hermes-agent")
    candidates.append(Path.home() / ".hermes" / "hermes-agent")

    seen: set[str] = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            resolved = candidate
        key = str(resolved)
        if key in seen:
            continue
        seen.add(key)
        if (resolved / "run_agent.py").exists():
            return resolved

    cli_dir = _resolve_agent_dir_from_hermes_cli()
    if cli_dir:
        return cli_dir

    raise WorkerError(
        "Hermes agent source not found.",
        code="hermes_not_found",
        hint="Set HERMES_AGENT_DIR or install Hermes into ~/.hermes/hermes-agent.",
    )


def _ensure_imports() -> None:
    if _IMPORTS_READY:
        return
    with _IMPORTS_LOCK:
        if _IMPORTS_READY:
            return
        _ensure_imports_unlocked()


def _ensure_imports_unlocked() -> None:
    global _AGENT_DIR, _IMPORTS_READY, _AIAgent, _AIAgent_PARAMS, _SessionDB

    _AGENT_DIR = _discover_agent_dir()
    agent_dir_str = str(_AGENT_DIR)
    if agent_dir_str not in sys.path:
        sys.path.append(agent_dir_str)

    try:
        from run_agent import AIAgent
    except ImportError as exc:
        raise WorkerError(
            f"Could not import Hermes AIAgent: {exc}",
            code="import_error",
            hint="Use HERMES_PYTHON=~/.hermes/hermes-agent/venv/bin/python.",
        ) from exc

    _AIAgent = AIAgent
    _AIAgent_PARAMS = set(inspect.signature(AIAgent.__init__).parameters)
    try:
        from hermes_state import SessionDB
        _SessionDB = SessionDB
    except Exception:
        _SessionDB = None

    _IMPORTS_READY = True


def _load_config() -> dict[str, Any]:
    global _CONFIG_CACHE, _CONFIG_MTIME
    _ensure_imports()

    config_path = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / "config.yaml"
    try:
        mtime = config_path.stat().st_mtime
    except OSError:
        mtime = 0.0

    if _CONFIG_CACHE is not None and mtime == _CONFIG_MTIME:
        return _CONFIG_CACHE

    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        result = cfg if isinstance(cfg, dict) else {}
    except Exception:
        result = {}

    _CONFIG_CACHE = result
    _CONFIG_MTIME = mtime
    return result


def _clear_model_list_cache() -> None:
    global _MODEL_LIST_CACHE
    with _MODEL_LIST_CACHE_LOCK:
        _MODEL_LIST_CACHE = None


def _model_section(cfg: dict[str, Any]) -> dict[str, Any]:
    model_cfg = cfg.get("model")
    if isinstance(model_cfg, dict):
        data = dict(model_cfg)
        if not data.get("default") and data.get("model"):
            data["default"] = data.get("model")
        return data
    if isinstance(model_cfg, str) and model_cfg.strip():
        return {"default": model_cfg.strip()}
    return {}


def _normalize_reasoning(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    return normalized if normalized in ALLOWED_REASONING else None


def _default_reasoning(cfg: dict[str, Any]) -> str | None:
    agent_cfg = cfg.get("agent")
    raw = agent_cfg.get("reasoning_effort") if isinstance(agent_cfg, dict) else None
    return _normalize_reasoning(raw) or "medium"


def _set_defaults(request: dict[str, Any]) -> dict[str, Any]:
    global _CONFIG_CACHE
    _ensure_imports()
    from hermes_cli.config import load_config as _load_full_config, save_config

    cfg = _load_full_config()

    if not isinstance(cfg.get("model"), dict):
        cfg["model"] = {}

    if "model" in request:
        raw_model = request["model"]
        if isinstance(raw_model, str) and raw_model.strip():
            model_val = raw_model.strip()
            parsed = _parse_provider_model(model_val)
            if parsed:
                provider_hint, bare_model = parsed
                if provider_hint and not _provider_hint_is_available(provider_hint):
                    _raise_invalid_provider(provider_hint)
                cfg["model"]["default"] = bare_model
                cfg["model"]["provider"] = provider_hint
            else:
                cfg["model"]["default"] = model_val
                cfg["model"].pop("provider", None)

    if "reasoningEffort" in request:
        normalized = _normalize_reasoning(request["reasoningEffort"])
        if normalized:
            if not isinstance(cfg.get("agent"), dict):
                cfg["agent"] = {}
            cfg["agent"]["reasoning_effort"] = normalized

    save_config(cfg)
    _CONFIG_CACHE = None
    _clear_model_list_cache()

    return _defaults_from_config(cfg)


def _defaults_from_config(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = cfg if cfg is not None else _load_config()
    model_cfg = _model_section(cfg)
    display_cfg = cfg.get("display")

    return {
        "provider": string_or_none(model_cfg.get("provider")),
        "model": string_or_none(model_cfg.get("default")),
        "baseUrl": string_or_none(model_cfg.get("base_url")),
        "apiMode": string_or_none(model_cfg.get("api_mode")),
        "reasoningEffort": _default_reasoning(cfg),
        "showReasoning": bool(display_cfg.get("show_reasoning")) if isinstance(display_cfg, dict) and isinstance(display_cfg.get("show_reasoning"), bool) else True,
    }


def _task_key_for(request: dict[str, Any]) -> str:
    return (
        string_or_none(request.get("taskId"))
        or string_or_none(request.get("sessionId"))
        or str(request.get("id"))
    )


def _try_mark_task_active(task_key: str, request_id: str) -> bool:
    with ACTIVE_TASKS_LOCK:
        if task_key in ACTIVE_TASKS:
            return False
        ACTIVE_TASKS[task_key] = request_id
        return True


def _clear_task_active(task_key: str, request_id: str) -> None:
    with ACTIVE_TASKS_LOCK:
        if ACTIVE_TASKS.get(task_key) == request_id:
            ACTIVE_TASKS.pop(task_key, None)


def _custom_providers(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        from hermes_cli.config import get_compatible_custom_providers

        providers = get_compatible_custom_providers(cfg)
        return providers if isinstance(providers, list) else []
    except Exception:
        raw = cfg.get("custom_providers")
        return raw if isinstance(raw, list) else []


def _custom_provider_models(entry: dict[str, Any]) -> list[str]:
    models: list[str] = []
    for key in ("model", "default_model"):
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            models.append(value.strip())

    raw_models = entry.get("models")
    if isinstance(raw_models, dict):
        models.extend(str(k).strip() for k in raw_models.keys() if str(k).strip())
    elif isinstance(raw_models, list):
        for item in raw_models:
            if isinstance(item, str) and item.strip():
                models.append(item.strip())
            elif isinstance(item, dict):
                mid = item.get("id") or item.get("model") or item.get("name")
                if isinstance(mid, str) and mid.strip():
                    models.append(mid.strip())

    return _dedupe(models)


def _parse_provider_model(raw: str) -> tuple[str, str] | None:
    if raw.startswith("@") and ":" in raw:
        provider, model = raw[1:].split(":", 1)
        return provider, model
    return None


def _provider_hint_is_available(provider: str) -> bool:
    if provider.startswith("custom:"):
        return True
    try:
        from hermes_cli.runtime_provider import resolve_runtime_provider  # type: ignore

        resolve_runtime_provider(requested=provider)
        return True
    except ImportError:
        return True
    except Exception:
        return False


def _raise_invalid_provider(provider: str) -> None:
    raise WorkerError(
        f"Provider '{provider}' is not configured or runnable by this Hermes install.",
        code="invalid_provider",
        hint="Choose a configured provider, or configure this provider in Hermes first.",
    )


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _add_model(
    groups: dict[str, list[dict[str, Any]]],
    provider: str,
    model_id: str,
    source: str,
    default_model: str | None,
    label: str | None = None,
) -> None:
    if not model_id:
        return
    bucket = groups.setdefault(provider or "configured", [])
    if any(item["id"] == model_id for item in bucket):
        return
    bucket.append({
        "id": model_id,
        "label": label or model_id,
        "source": source,
        "isCurrentDefault": bool(default_model and model_id == default_model),
    })


def _provider_model_ids_with_timeout(provider: str, timeout: float = 4.0) -> list[str]:
    try:
        future = _MODEL_EXECUTOR.submit(_provider_model_ids, provider)
        return future.result(timeout=timeout)
    except TimeoutError:
        return []
    except Exception:
        return []


def _provider_model_ids(provider: str) -> list[str]:
    from hermes_cli.models import provider_model_ids

    models = provider_model_ids(provider)
    return [str(model).strip() for model in models or [] if str(model).strip()]


def _groups_have_model(groups: dict[str, list[dict[str, Any]]], model_id: str) -> bool:
    return any(
        item.get("id") == model_id
        for models in groups.values()
        for item in models
    )


def _model_option_id(provider: str | None, model_id: str, active_provider: str | None) -> str:
    if not provider or provider == active_provider:
        return model_id
    if provider.startswith("custom:"):
        return model_id
    return f"@{provider}:{model_id}"


def _list_authenticated_model_groups(
    cfg: dict[str, Any],
    defaults: dict[str, Any],
) -> dict[str, list[dict[str, Any]]] | None:
    try:
        from hermes_cli.model_switch import list_authenticated_providers
    except Exception:
        return None

    providers_cfg = cfg.get("providers")
    user_providers = providers_cfg if isinstance(providers_cfg, dict) else {}
    custom_providers = _custom_providers(cfg)
    active_provider = defaults["provider"]
    default_model = defaults["model"]
    groups: dict[str, list[dict[str, Any]]] = {}

    try:
        providers = list_authenticated_providers(
            current_provider=active_provider or "",
            current_base_url=defaults.get("baseUrl") or "",
            current_model=default_model or "",
            user_providers=user_providers,
            custom_providers=custom_providers,
            max_models=500,
        )
    except Exception:
        return None

    for provider_info in providers:
        if not isinstance(provider_info, dict):
            continue
        slug = string_or_none(provider_info.get("slug"))
        group_name = string_or_none(provider_info.get("name")) or slug or "configured"
        is_user_defined = bool(provider_info.get("is_user_defined"))
        if not is_user_defined and slug and not _provider_hint_is_available(slug):
            continue
        source = "custom" if is_user_defined else "catalog"
        models = provider_info.get("models")
        if not isinstance(models, list):
            continue
        for raw_model in models:
            model_id = string_or_none(raw_model)
            if not model_id:
                continue
            option_id = model_id if is_user_defined else _model_option_id(slug, model_id, active_provider)
            _add_model(groups, group_name, option_id, source, default_model, label=model_id)

    return groups


def _list_models() -> dict[str, Any]:
    global _MODEL_LIST_CACHE

    cfg = _load_config()
    config_mtime = _CONFIG_MTIME
    now = time.monotonic()
    with _MODEL_LIST_CACHE_LOCK:
        cached = _MODEL_LIST_CACHE
        if cached is not None and cached.config_mtime == config_mtime and now < cached.expires_at:
            return cached.data

    defaults = _defaults_from_config(cfg)
    default_model = defaults["model"]
    active_provider = defaults["provider"]
    authenticated_groups = _list_authenticated_model_groups(cfg, defaults)
    groups = authenticated_groups or {}

    if default_model and not _groups_have_model(groups, default_model):
        _add_model(groups, active_provider or "current", default_model, "current", default_model)

    if active_provider and authenticated_groups is None:
        for model_id in _provider_model_ids_with_timeout(active_provider):
            _add_model(groups, active_provider, model_id, "catalog", default_model)

    for entry in _custom_providers(cfg):
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "custom").strip() or "custom"
        provider = f"custom:{name.lower().replace(' ', '-')}"
        for model_id in _custom_provider_models(entry):
            _add_model(groups, provider, model_id, "custom", default_model)

    aliases = cfg.get("model_aliases")
    if isinstance(aliases, dict):
        for alias, target in aliases.items():
            if isinstance(alias, str) and alias.strip():
                label = f"{alias.strip()} -> {target}" if target else alias.strip()
                bucket = groups.setdefault("aliases", [])
                if not any(item["id"] == alias.strip() for item in bucket):
                    bucket.append({
                        "id": alias.strip(),
                        "label": label,
                        "source": "alias",
                        "isCurrentDefault": bool(default_model and alias.strip() == default_model),
                    })

    result = {
        "defaultModel": default_model,
        "activeProvider": active_provider,
        "groups": [{"provider": provider, "models": models} for provider, models in groups.items()],
    }

    with _MODEL_LIST_CACHE_LOCK:
        _MODEL_LIST_CACHE = _ModelListCache(
            data=result,
            config_mtime=config_mtime,
            expires_at=time.monotonic() + _MODEL_LIST_CACHE_TTL_SECONDS,
        )

    return result


def _resolve_model_provider(requested_model: str | None, cfg: dict[str, Any] | None = None) -> tuple[str, str | None, str | None]:
    cfg = cfg if cfg is not None else _load_config()
    model_cfg = _model_section(cfg)
    config_provider = string_or_none(model_cfg.get("provider"))
    config_base_url = string_or_none(model_cfg.get("base_url"))
    default_model = string_or_none(model_cfg.get("default"))
    model_id = (requested_model or default_model or "").strip()

    if not model_id:
        return model_id, config_provider, config_base_url

    for entry in _custom_providers(cfg):
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        if model_id in _custom_provider_models(entry):
            return model_id, f"custom:{name.lower().replace(' ', '-')}", string_or_none(entry.get("base_url"))

    parsed = _parse_provider_model(model_id)
    if parsed:
        provider_hint, bare_model = parsed
        return bare_model, provider_hint or config_provider, None

    if "/" in model_id:
        prefix, bare = model_id.split("/", 1)
        prefix_normalized = prefix.lower()
        if config_provider == "openrouter":
            return model_id, "openrouter", config_base_url
        if config_provider and prefix_normalized == config_provider:
            return bare, config_provider, config_base_url
        if config_provider in {"nous", "opencode-zen", "opencode-go"}:
            return model_id, config_provider, config_base_url
        if config_base_url:
            if prefix_normalized in KNOWN_PROVIDER_PREFIXES:
                return bare, config_provider, config_base_url
            return model_id, config_provider, config_base_url
        if prefix_normalized in KNOWN_PROVIDER_PREFIXES and prefix_normalized != config_provider:
            return model_id, "openrouter", None

    return model_id, config_provider, config_base_url


def _resolve_toolsets(cfg: dict[str, Any]) -> list[str] | None:
    try:
        from hermes_cli.tools_config import _get_platform_tools

        toolsets = _get_platform_tools(cfg, "cli")
        return list(toolsets) if toolsets else None
    except Exception:
        platform_toolsets = cfg.get("platform_toolsets")
        if isinstance(platform_toolsets, dict) and isinstance(platform_toolsets.get("cli"), list):
            return list(platform_toolsets["cli"])
    return None


def _fallback_model(cfg: dict[str, Any]) -> dict[str, Any] | None:
    raw = cfg.get("fallback_model")
    if not isinstance(raw, dict):
        return None
    model = string_or_none(raw.get("model"))
    if not model:
        return None
    return {
        "model": model,
        "provider": string_or_none(raw.get("provider")),
        "base_url": string_or_none(raw.get("base_url")),
    }


def _parse_reasoning(effort: str | None) -> dict[str, Any] | None:
    if not effort:
        return None
    try:
        from hermes_constants import parse_reasoning_effort

        return parse_reasoning_effort(effort)
    except Exception:
        if effort == "none":
            return {"enabled": False}
        if effort in ALLOWED_REASONING:
            return {"enabled": True, "effort": effort}
    return None


def _create_agent(
    *,
    session_id: str,
    requested_model: str | None,
    reasoning_effort: str | None,
    callbacks: dict[str, Any] | None = None,
) -> Any:
    _ensure_imports()
    cfg = _load_config()
    defaults = _defaults_from_config(cfg)
    resolved_reasoning_effort = reasoning_effort or defaults.get("reasoningEffort")
    resolved_model, resolved_provider, resolved_base_url = _resolve_model_provider(requested_model, cfg)

    try:
        from hermes_cli.runtime_provider import resolve_runtime_provider  # type: ignore

        runtime = resolve_runtime_provider(
            requested=resolved_provider,
            explicit_base_url=resolved_base_url,
            target_model=resolved_model,
        )
    except Exception as exc:
        err = _error_payload(exc)
        raise WorkerError(str(exc), code=err.get("code", "worker_error"), hint=err.get("hint")) from exc

    if not resolved_provider:
        resolved_provider = string_or_none(runtime.get("provider"))
    if not resolved_base_url:
        resolved_base_url = string_or_none(runtime.get("base_url"))

    def clarify_callback(question: Any, choices: Any = None) -> str:
        return (
            "The user is not available for an interactive clarification right now. "
            "Make a reasonable assumption, proceed, and call out the assumption in the response if it matters."
        )

    session_db = None
    if _SessionDB is not None:
        try:
            session_db = _SessionDB()
        except Exception:
            session_db = None

    agent_params = _AIAgent_PARAMS
    agent_kwargs: dict[str, Any] = {
        "model": resolved_model,
        "provider": resolved_provider,
        "base_url": resolved_base_url,
        "api_key": runtime.get("api_key"),
        "quiet_mode": True,
        "verbose_logging": False,
        "platform": "minions",
        "session_id": session_id,
        "session_db": session_db,
        "enabled_toolsets": _resolve_toolsets(cfg),
        "fallback_model": _fallback_model(cfg),
        "clarify_callback": clarify_callback,
    }
    if callbacks:
        agent_kwargs.update(callbacks)

    reasoning_config = _parse_reasoning(resolved_reasoning_effort)
    if "reasoning_config" in agent_params and reasoning_config is not None:
        agent_kwargs["reasoning_config"] = reasoning_config
    if "api_mode" in agent_params:
        agent_kwargs["api_mode"] = runtime.get("api_mode")
    if "acp_command" in agent_params:
        agent_kwargs["acp_command"] = runtime.get("command")
    elif "command" in agent_params:
        agent_kwargs["command"] = runtime.get("command")
    if "acp_args" in agent_params:
        agent_kwargs["acp_args"] = list(runtime.get("args") or [])
    elif "args" in agent_params:
        agent_kwargs["args"] = list(runtime.get("args") or [])
    if "credential_pool" in agent_params:
        agent_kwargs["credential_pool"] = runtime.get("credential_pool")
    if "gateway_session_key" in agent_params:
        agent_kwargs["gateway_session_key"] = session_id

    filtered_kwargs = {
        key: value
        for key, value in agent_kwargs.items()
        if key in agent_params and value is not None
    }

    return _AIAgent(**filtered_kwargs)


def _sync_session_identity(agent: Any, session_id: str) -> None:
    """Refresh persisted Hermes session metadata when Minions switches models."""
    session_db = getattr(agent, "_session_db", None)
    model = string_or_none(getattr(agent, "model", None))
    if not session_db or not session_id or not model:
        return

    try:
        session_row = session_db.get_session(session_id)
    except Exception:
        return
    if not session_row:
        return

    model_config = getattr(agent, "_session_init_model_config", None)
    stored_model = string_or_none(session_row.get("model"))
    if stored_model == model:
        return

    model_config_json = None
    if model_config:
        try:
            model_config_json = json.dumps(model_config)
        except Exception:
            model_config_json = None

    execute_write = getattr(session_db, "_execute_write", None)
    if callable(execute_write):
        def _do(conn: Any) -> None:
            if model_config_json is None:
                conn.execute(
                    "UPDATE sessions SET model = ?, system_prompt = NULL WHERE id = ?",
                    (model, session_id),
                )
            else:
                conn.execute(
                    "UPDATE sessions SET model = ?, model_config = ?, system_prompt = NULL WHERE id = ?",
                    (model, model_config_json, session_id),
                )

        try:
            execute_write(_do)
        except Exception:
            return
    else:
        try:
            session_db.update_system_prompt(session_id, None)
        except Exception:
            return

    try:
        setattr(agent, "_cached_system_prompt", None)
    except Exception:
        pass


def _warm_agent() -> None:
    _create_agent(
        session_id="minions-healthcheck",
        requested_model=None,
        reasoning_effort=None,
    )


def _run_chat(request_id: str, request: dict[str, Any]) -> None:
    settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
    requested_model = string_or_none(settings.get("model"))
    requested_effort = _normalize_reasoning(settings.get("reasoningEffort"))

    session_id = string_or_none(request.get("sessionId")) or request_id
    message = request.get("message")
    if not isinstance(message, str) or not message.strip():
        raise WorkerError("Chat request message is required.", code="bad_request")

    session_db, session_id = open_session(session_id)
    history = load_agent_history(session_db, session_id)
    system_message = request.get("systemMessage")
    if not isinstance(system_message, str):
        system_message = None

    state = {"text": "", "thinking": ""}

    def on_text_delta(text: Any) -> None:
        if text is None:
            return
        chunk = str(text)
        state["text"] += chunk
        _send({"id": request_id, "type": "text_delta", "content": chunk})

    def on_reasoning_delta(text: Any) -> None:
        if text is None:
            return
        chunk = str(text)
        if not chunk:
            return
        state["thinking"] += chunk
        _send({"id": request_id, "type": "thinking_delta", "content": chunk})

    def on_tool_progress(*args: Any, **kwargs: Any) -> None:
        event_type = None
        name = None
        preview = None
        tool_args = None

        if len(args) >= 4:
            event_type, name, preview, tool_args = args[:4]
        elif len(args) == 3:
            name, preview, tool_args = args
            event_type = "tool.started"
        elif len(args) == 2:
            event_type, name = args
        elif len(args) == 1:
            name = args[0]
            event_type = "tool.started"

        tool_name = str(name or "tool")
        if event_type in {None, "tool.started"}:
            _send({
                "id": request_id,
                "type": "tool_progress",
                "tool": tool_name,
                "status": "running",
                "label": str(preview) if preview else None,
            })
            return

        if event_type == "tool.completed":
            _send({
                "id": request_id,
                "type": "tool_progress",
                "tool": tool_name,
                "status": "error" if kwargs.get("is_error") else "completed",
                "duration": kwargs.get("duration"),
                "label": str(preview) if preview else None,
            })

    agent = _create_agent(
        session_id=session_id,
        requested_model=requested_model,
        reasoning_effort=requested_effort,
        callbacks={
            "stream_delta_callback": on_text_delta,
            "reasoning_callback": on_reasoning_delta,
            "tool_progress_callback": on_tool_progress,
        },
    )
    _sync_session_identity(agent, session_id)
    task_id = string_or_none(request.get("taskId")) or session_id
    task_title = string_or_none(request.get("taskTitle")) or task_id
    session_tokens = None
    clear_session_vars = None
    try:
        from gateway.session_context import set_session_vars, clear_session_vars as _clear_session_vars

        clear_session_vars = _clear_session_vars
        session_tokens = set_session_vars(
            platform="minions",
            chat_id=task_id,
            chat_name=task_title,
            session_key=session_id,
        )
    except Exception:
        session_tokens = None

    try:
        result = agent.run_conversation(
            user_message=message,
            system_message=system_message,
            conversation_history=history,
            task_id=session_id,
        )
    finally:
        if session_tokens is not None and clear_session_vars is not None:
            try:
                clear_session_vars(session_tokens)
            except Exception:
                pass

    final_text = str(result.get("final_response") or "")
    if final_text and not state["text"]:
        _send({"id": request_id, "type": "text_delta", "content": final_text})
    if result.get("last_reasoning") and not state["thinking"]:
        _send({"id": request_id, "type": "thinking_delta", "content": str(result["last_reasoning"])})

    context_engine = getattr(agent, "context_compressor", None)
    context_used = int(result.get("last_prompt_tokens") or 0)
    context_window = int(getattr(context_engine, "context_length", 0) or 0)
    context = None
    if context_used > 0 and context_window > 0:
        context = {
            "used_tokens": context_used,
            "window_tokens": context_window,
        }
    _send({"id": request_id, "type": "done", "sessionId": getattr(agent, "session_id", None) or session_id, "context": context})


def _run_chat_thread(request_id: str, request: dict[str, Any], task_key: str) -> None:
    done_sent = False
    acquired = False
    try:
        AGENT_SEMAPHORE.acquire()
        acquired = True
        _run_chat(request_id, request)
        done_sent = True
    except Exception as exc:
        _send_error(request_id, exc)
    finally:
        if not done_sent:
            _send({
                "id": request_id,
                "type": "done",
                "sessionId": string_or_none(request.get("sessionId")) or request_id,
            })
        if acquired:
            AGENT_SEMAPHORE.release()
        _clear_task_active(task_key, request_id)


def _run_one_shot_agent(label: str, system_message: str, user_message: str) -> str:
    """Run a throwaway zero-reasoning agent turn and return its raw text response."""
    agent = _create_agent(
        session_id=f"minions-{label}-{uuid.uuid4().hex[:8]}",
        requested_model=None,
        reasoning_effort="none",
    )
    result = agent.run_conversation(
        user_message=user_message,
        system_message=system_message,
        conversation_history=[],
    )
    return str(result.get("final_response") or "")


def _submit_background_agent_request(
    request_id: str,
    request: dict[str, Any],
    *,
    name_prefix: str,
    handler: Callable[[dict[str, Any]], dict[str, Any]],
) -> None:
    def runner() -> None:
        acquired = False
        try:
            AGENT_SEMAPHORE.acquire()
            acquired = True
            _result(request_id, handler(request))
        except Exception as exc:
            _send_error(request_id, exc)
        finally:
            if acquired:
                AGENT_SEMAPHORE.release()

    threading.Thread(
        target=runner,
        daemon=True,
        name=f"{name_prefix}-{request_id[:8]}",
    ).start()


def _judge_completion(request: dict[str, Any]) -> dict[str, Any]:
    """Evaluate whether the agent's response indicates task completion."""
    task_title = string_or_none(request.get("taskTitle")) or ""
    task_description = string_or_none(request.get("taskDescription")) or ""
    response_text = string_or_none(request.get("responseText")) or ""

    if not response_text:
        return {"done": False, "reason": "empty response"}

    response_text = truncate_with_ellipsis(response_text, 4000)

    task_context = task_title
    if task_description:
        task_context += f"\n{task_description}"

    judge_system = (
        "You are a task completion judge. "
        "Respond ONLY with a JSON object, nothing else. "
        "Do not use any tools."
    )

    judge_prompt = (
        f"Task:\n{task_context}\n\n"
        f"Agent's most recent response:\n{response_text}\n\n"
        'Has the agent completed the task? Respond with: {"done": true/false, "reason": "one sentence"}\n'
        "- done=true ONLY when the response clearly delivers the final result or confirms completion\n"
        "- done=false for: questions, partial progress, clarification requests, errors, or ongoing work"
    )

    text = _run_one_shot_agent("judge", judge_system, judge_prompt)
    json_match = re.search(r"\{[^{}]*\}", text)
    if json_match:
        try:
            parsed = json.loads(json_match.group())
            return {
                "done": bool(parsed.get("done", False)),
                "reason": str(parsed.get("reason", "")),
            }
        except (json.JSONDecodeError, ValueError):
            pass

    return {"done": False, "reason": "unparseable response"}


def _clean_generated_title(raw: str) -> str:
    """Sanitize the LLM's title output: strip quotes, trailing punctuation, cap length."""
    stripped = raw.strip()
    if not stripped:
        return ""
    title = stripped.splitlines()[0].strip()
    # Strip wrapping quotes/backticks the model often adds (handles nested quotes)
    while len(title) >= 2 and title[0] in {'"', "'", "`"} and title[-1] == title[0]:
        title = title[1:-1].strip()
    title = title.rstrip(".!?,;:")
    return truncate_with_ellipsis(title, 60)


def _generate_title(request: dict[str, Any]) -> dict[str, Any]:
    """Generate a short descriptive title for a task from its initial message."""
    description = string_or_none(request.get("description")) or ""
    if not description:
        return {"title": ""}

    description = truncate_with_ellipsis(description, 2000)

    title_system = (
        "You generate short, descriptive titles for tasks. "
        "Reply with ONLY the title text — no quotes, no preamble, no trailing punctuation. "
        "Do not use any tools."
    )

    title_prompt = (
        f"Write a concise 3-7 word title for this task:\n\n{description}\n\n"
        "Reply with only the title."
    )

    text = _run_one_shot_agent("title", title_system, title_prompt)
    return {"title": _clean_generated_title(text)}


def _submit_chat_request(request_id: str, request: dict[str, Any]) -> None:
    task_key = _task_key_for(request)
    if not _try_mark_task_active(task_key, request_id):
        _send_error(
            request_id,
            WorkerError(
                "This task is already running. Wait for the current turn to finish, then retry.",
                code="task_busy",
            ),
        )
        _send({
            "id": request_id,
            "type": "done",
            "sessionId": string_or_none(request.get("sessionId")) or request_id,
        })
        return

    thread = threading.Thread(
        target=_run_chat_thread,
        args=(request_id, request, task_key),
        daemon=True,
        name=f"agent-{request_id[:8]}",
    )
    thread.start()


def _handle_request(request: dict[str, Any]) -> None:
    request_id = str(request.get("id") or "")
    if not request_id:
        return

    request_type = request.get("type")
    try:
        if request_type == "health":
            _warm_agent()
            _result(request_id, {
                "ok": True,
                "agentDir": str(_AGENT_DIR) if _AGENT_DIR else None,
                "python": sys.executable,
            })
        elif request_type == "settings.get":
            _result(request_id, _defaults_from_config())
        elif request_type == "settings.set":
            _result(request_id, _set_defaults(request))
        elif request_type == "models.list":
            _result(request_id, _list_models())
        elif request_type == "cron.jobs.list":
            _result(request_id, list_cron_jobs(bool(request.get("includeDisabled"))))
        elif request_type == "cron.jobs.get":
            _result(request_id, get_cron_job(request.get("jobId")))
        elif request_type == "cron.jobs.runs":
            _result(request_id, list_cron_runs(request.get("jobId"), request.get("limit", 20)))
        elif request_type == "cron.jobs.run.content":
            _result(request_id, get_cron_run_content(request.get("jobId"), request.get("runId")))
        elif request_type == "cron.jobs.pause":
            _result(request_id, pause_cron_job(request.get("jobId"), request.get("reason")))
        elif request_type == "cron.jobs.resume":
            _result(request_id, resume_cron_job(request.get("jobId")))
        elif request_type == "cron.jobs.run":
            _result(request_id, trigger_cron_job(request.get("jobId")))
        elif request_type == "cron.jobs.remove":
            _result(request_id, remove_cron_job(request.get("jobId")))
        elif request_type == "cron.tick":
            _result(request_id, {"executed": tick_cron()})
        elif request_type == "session.messages.get":
            _result(request_id, project_session_messages(request.get("sessionId"), request.get("taskId")))
        elif request_type == "session.get":
            _result(request_id, project_session_metadata(request.get("sessionId")))
        elif request_type == "chat":
            _submit_chat_request(request_id, request)
        elif request_type == "judge.completion":
            _submit_background_agent_request(request_id, request, name_prefix="judge", handler=_judge_completion)
        elif request_type == "title.generate":
            _submit_background_agent_request(request_id, request, name_prefix="title", handler=_generate_title)
        else:
            raise WorkerError(f"Unknown request type: {request_type}", code="bad_request")
    except Exception as exc:
        _send_error(request_id, exc)
        if request_type == "chat":
            _send({
                "id": request_id,
                "type": "done",
                "sessionId": string_or_none(request.get("sessionId")) or request_id,
            })


def _run_loop() -> None:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                continue
            _handle_request(request)
        except Exception as exc:
            print(f"[hermes-worker] failed to handle request: {exc}", file=sys.stderr, flush=True)
            traceback.print_exc(file=sys.stderr)


def _self_test() -> int:
    try:
        _ensure_imports()
        cfg = _load_config()
        payload = {
            "ok": True,
            "agentDir": str(_AGENT_DIR) if _AGENT_DIR else None,
            "python": sys.executable,
            "defaults": _defaults_from_config(cfg),
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": _error_payload(exc)}, ensure_ascii=False, indent=2))
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    os.environ.setdefault("HERMES_QUIET", "1")
    os.environ.setdefault("HERMES_YOLO_MODE", "1")

    if args.self_test:
        return _self_test()

    sys.stdout = sys.stderr
    start_cron_ticker()
    try:
        _run_loop()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
