#!/usr/bin/env python3
"""JSONL bridge between Minions and Hermes AIAgent."""

from __future__ import annotations

import argparse
import dataclasses
import inspect
import json
import os
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
from hermes_scheduled_tasks import (
    create_scheduled_task,
    get_scheduled_task,
    list_scheduled_tasks,
    pause_scheduled_task,
    remove_scheduled_task,
    resume_scheduled_task,
    start_scheduled_task_ticker,
    tick_scheduled_tasks,
    trigger_scheduled_task,
    update_scheduled_task,
)

PROTOCOL_OUT = sys.stdout
PROTOCOL_LOCK = threading.Lock()
# Keep in sync with MINIONS_GOAL_MAX_TURNS in shared/types.ts.
MINIONS_GOAL_MAX_TURNS = 20

# Cap on concurrent AIAgent.run_conversation calls.
AGENT_RUN_LIMIT = int(os.environ.get("HERMES_AGENT_RUN_LIMIT", "10"))
AGENT_SEMAPHORE = threading.BoundedSemaphore(AGENT_RUN_LIMIT)
ACTIVE_TASKS: dict[str, str] = {}
ACTIVE_AGENTS: dict[str, Any] = {}
PENDING_INTERRUPTS: dict[str, str] = {}
ACTIVE_TASKS_LOCK = threading.Lock()
DEFAULT_INTERRUPT_REASON = "Stopped by user"

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
    "minimax-cn",
    "mistral",
    "mistralai",
    "moonshotai",
    "nous",
    "nvidia",
    "ollama",
    "ollama-cloud",
    "opencode-go",
    "opencode-zen",
    "openrouter",
    "qwen",
    "x-ai",
    "xai",
    "xiaomi",
    "z-ai",
    "zai",
}
PORTAL_PROVIDERS = {"nous", "opencode-zen", "opencode-go", "nvidia"}
LOCAL_SERVER_PROVIDERS = {
    "lmstudio",
    "lm-studio",
    "ollama",
    "llamacpp",
    "llama-cpp",
    "vllm",
    "tabby",
    "tabbyapi",
    "koboldcpp",
    "textgen",
    "localai",
}
CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
RUNTIME_MANAGED_PROVIDER_PREFIXES = {
    "copilot",
    "copilot-acp",
    "google-gemini-cli",
    "minimax-oauth",
    "nous",
    "openai-codex",
    "qwen-oauth",
}
MODEL_RUNTIME_OVERRIDE_KEYS = ("base_url", "api_key", "api", "api_mode")

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

    provider_present = "provider" in request
    requested_provider = string_or_none(request.get("provider")) if provider_present else None
    if requested_provider and not _provider_hint_is_selectable(requested_provider, cfg):
        _raise_invalid_provider(requested_provider)

    if "model" in request:
        raw_model = request["model"]
        if isinstance(raw_model, str) and raw_model.strip():
            model_val = raw_model.strip()
            parsed = _parse_provider_model(model_val)
            previous_provider = string_or_none(cfg["model"].get("provider"))
            if parsed:
                parsed_provider, bare_model = parsed
                provider_hint = requested_provider or parsed_provider
                if provider_hint and not _provider_hint_is_selectable(provider_hint, cfg):
                    _raise_invalid_provider(provider_hint)
                cfg["model"]["default"] = bare_model
                if provider_hint:
                    cfg["model"]["provider"] = provider_hint
                if (
                    provider_hint != previous_provider
                    or provider_hint in RUNTIME_MANAGED_PROVIDER_PREFIXES
                ):
                    _clear_model_runtime_overrides(cfg["model"])
            else:
                if requested_provider:
                    resolved_model, resolved_provider = model_val, requested_provider
                else:
                    resolved_model, resolved_provider, _ = _resolve_model_provider(model_val, cfg)
                if resolved_provider and not _provider_hint_is_selectable(resolved_provider, cfg):
                    _raise_invalid_provider(resolved_provider)
                cfg["model"]["default"] = resolved_model
                if resolved_provider:
                    cfg["model"]["provider"] = resolved_provider
                else:
                    cfg["model"].pop("provider", None)
                if (
                    resolved_provider != previous_provider
                    or resolved_provider in RUNTIME_MANAGED_PROVIDER_PREFIXES
                ):
                    _clear_model_runtime_overrides(cfg["model"])
    elif provider_present:
        previous_provider = string_or_none(cfg["model"].get("provider"))
        if requested_provider:
            cfg["model"]["provider"] = requested_provider
        else:
            cfg["model"].pop("provider", None)
        if requested_provider != previous_provider:
            _clear_model_runtime_overrides(cfg["model"])

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


def _clear_model_runtime_overrides(model_cfg: dict[str, Any]) -> None:
    for key in MODEL_RUNTIME_OVERRIDE_KEYS:
        model_cfg.pop(key, None)


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


def _try_interrupt_agent(agent: Any, reason: str) -> bool:
    if agent is not None and hasattr(agent, "interrupt"):
        agent.interrupt(reason)
        return True
    return False


def _register_active_agent(task_key: str, request_id: str, agent: Any) -> None:
    pending_reason = None
    with ACTIVE_TASKS_LOCK:
        if ACTIVE_TASKS.get(task_key) != request_id:
            return
        ACTIVE_AGENTS[task_key] = agent
        pending_reason = PENDING_INTERRUPTS.pop(task_key, None)

    # An interrupt that arrived before this agent was constructed was parked in
    # PENDING_INTERRUPTS; apply it now that the agent exists.
    if pending_reason:
        _try_interrupt_agent(agent, pending_reason)


def _clear_task_active(task_key: str, request_id: str) -> None:
    with ACTIVE_TASKS_LOCK:
        if ACTIVE_TASKS.get(task_key) == request_id:
            ACTIVE_TASKS.pop(task_key, None)
            ACTIVE_AGENTS.pop(task_key, None)
            PENDING_INTERRUPTS.pop(task_key, None)


def _interrupt_active_chat(request: dict[str, Any]) -> dict[str, bool]:
    task_key = _task_key_for(request)
    reason = string_or_none(request.get("reason")) or DEFAULT_INTERRUPT_REASON

    with ACTIVE_TASKS_LOCK:
        if task_key not in ACTIVE_TASKS:
            return {"interrupted": False}

        agent = ACTIVE_AGENTS.get(task_key)
        if agent is None:
            # The run is active but its agent isn't registered yet. Park the reason
            # so _register_active_agent applies it the moment the agent is created.
            PENDING_INTERRUPTS[task_key] = reason
            return {"interrupted": True}

    return {"interrupted": _try_interrupt_agent(agent, reason)}


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
        inner = raw[1:]
        provider, model = inner.rsplit(":", 1)
        if provider.startswith("custom:") and provider.count(":") >= 2:
            slug_rest = provider[len("custom:"):]
            if not _custom_slug_rest_looks_like_host_port(slug_rest):
                provider, extra = provider.rsplit(":", 1)
                model = f"{extra}:{model}"
        elif provider not in KNOWN_PROVIDER_PREFIXES and not provider.startswith("custom:"):
            provider, model = inner.split(":", 1)
        return provider, model
    return None


def _custom_slug_rest_looks_like_host_port(rest: str) -> bool:
    rest = str(rest or "").strip()
    if ":" not in rest:
        return False
    host, port_s = rest.rsplit(":", 1)
    if not host or ":" in host or not port_s.isdigit():
        return False
    if not (1 <= int(port_s) <= 65535):
        return False
    try:
        import ipaddress

        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    host_l = host.lower()
    return host_l == "localhost" or "." in host


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


def _provider_hint_is_selectable(provider: str, cfg: dict[str, Any]) -> bool:
    if _provider_hint_is_available(provider):
        return True

    provider_l = provider.strip().lower()
    groups = _list_authenticated_model_groups(cfg, _defaults_from_config(cfg)) or {}
    return any(
        (string_or_none(model.get("provider")) or "").lower() == provider_l
        for models in groups.values()
        for model in models
    )


def _raise_invalid_provider(provider: str) -> None:
    raise WorkerError(
        f"Provider '{provider}' is not configured for this Hermes install.",
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
    provider_id: str | None = None,
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
        "provider": provider_id,
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


def _is_local_server_provider(provider: str | None) -> bool:
    provider_l = str(provider or "").strip().lower()
    if provider_l in LOCAL_SERVER_PROVIDERS:
        return True
    if provider_l.startswith("custom:"):
        return provider_l.removeprefix("custom:") in LOCAL_SERVER_PROVIDERS
    return False


def _base_url_points_at_local_server(base_url: str | None) -> bool:
    if not base_url:
        return False
    try:
        import ipaddress
        from urllib.parse import urlparse

        host = (urlparse(base_url).hostname or "").lower()
        if host in {"localhost", "ip6-localhost", "ip6-loopback"}:
            return True
        if not host:
            return False
        try:
            addr = ipaddress.ip_address(host)
        except ValueError:
            return False
        return addr.is_loopback or addr.is_private or addr.is_link_local
    except Exception:
        return False


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
        # Inventory view — runtime validation happens in _create_agent().
        source = "custom" if is_user_defined else "catalog"
        models = provider_info.get("models")
        if not isinstance(models, list):
            continue
        for raw_model in models:
            model_id = string_or_none(raw_model)
            if not model_id:
                continue
            option_id = model_id if is_user_defined else _model_option_id(slug, model_id, active_provider)
            _add_model(groups, group_name, option_id, source, default_model, label=model_id, provider_id=slug)

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
        _add_model(groups, active_provider or "current", default_model, "current", default_model, provider_id=active_provider)

    if active_provider and authenticated_groups is None:
        for model_id in _provider_model_ids_with_timeout(active_provider):
            _add_model(groups, active_provider, model_id, "catalog", default_model, provider_id=active_provider)

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
    config_provider_l = (config_provider or "").lower()
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
        if config_provider_l == "openrouter":
            return model_id, "openrouter", config_base_url
        if config_provider_l in PORTAL_PROVIDERS:
            return model_id, config_provider, config_base_url
        if config_provider and prefix_normalized == config_provider_l:
            return bare, config_provider, config_base_url
        if (
            config_provider_l == "openai-codex"
            and (config_base_url or "").rstrip("/") == CODEX_BASE_URL
            and prefix_normalized in KNOWN_PROVIDER_PREFIXES
            and prefix_normalized != config_provider_l
        ):
            return model_id, "openrouter", None
        if config_base_url:
            if _is_local_server_provider(config_provider) or _base_url_points_at_local_server(config_base_url):
                return model_id, config_provider, config_base_url
            if prefix_normalized in KNOWN_PROVIDER_PREFIXES:
                return bare, config_provider, config_base_url
            return model_id, config_provider, config_base_url
        if prefix_normalized in KNOWN_PROVIDER_PREFIXES and prefix_normalized != config_provider_l:
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


def _normalize_fallback_entry(raw: Any) -> dict[str, Any] | None:
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


def _fallback_model(cfg: dict[str, Any]) -> dict[str, Any] | list[dict[str, Any]] | None:
    raw_chain = cfg.get("fallback_providers")
    if isinstance(raw_chain, list):
        chain = [
            entry
            for item in raw_chain
            if (entry := _normalize_fallback_entry(item)) is not None
        ]
        if chain:
            return chain

    return _normalize_fallback_entry(cfg.get("fallback_model"))


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

    agent = _AIAgent(**filtered_kwargs)
    # Stash the resolved provider so _run_chat can report it in the done event
    agent._minions_resolved_provider = resolved_provider
    return agent


def _agent_failure_message(text: str) -> str | None:
    clean = str(text or "").strip()
    if not clean:
        return None

    failure_prefixes = (
        "API call failed after",
        "Rate limited after",
        "Non-retryable client error",
    )
    if clean.startswith(failure_prefixes):
        return clean

    return None


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
    _load_config()


def _goal_manager(session_id: str) -> Any:
    _ensure_imports()
    if not session_id:
        raise WorkerError("Session ID is required.", code="bad_request")
    from hermes_cli.goals import GoalManager

    return GoalManager(session_id=session_id, default_max_turns=MINIONS_GOAL_MAX_TURNS)


def _project_goal_state(state: Any) -> dict[str, Any] | None:
    if not state:
        return None
    return {
        "goal": str(getattr(state, "goal", "") or ""),
        "status": str(getattr(state, "status", "") or "active"),
        "turnsUsed": int(getattr(state, "turns_used", 0) or 0),
        "maxTurns": int(getattr(state, "max_turns", 0) or 0),
        "lastReason": string_or_none(getattr(state, "last_reason", None)),
        "pausedReason": string_or_none(getattr(state, "paused_reason", None)),
    }


def _project_goal_decision(decision: dict[str, Any], state: Any) -> dict[str, Any]:
    return {
        "status": string_or_none(decision.get("status")),
        "shouldContinue": bool(decision.get("should_continue")),
        "continuationPrompt": string_or_none(decision.get("continuation_prompt")),
        "verdict": string_or_none(decision.get("verdict")) or "inactive",
        "reason": string_or_none(decision.get("reason")) or "",
        "message": string_or_none(decision.get("message")) or "",
        "state": _project_goal_state(state),
    }


def _goal_mgr_from_request(request: dict[str, Any]) -> Any:
    return _goal_manager(string_or_none(request.get("sessionId")) or "")


def _goal_status(request: dict[str, Any]) -> dict[str, Any]:
    mgr = _goal_mgr_from_request(request)
    return {"goal": _project_goal_state(mgr.state)}


def _goal_set(request: dict[str, Any]) -> dict[str, Any]:
    goal = string_or_none(request.get("goal")) or ""
    if not goal.strip():
        raise WorkerError("Goal text is required.", code="bad_request")

    mgr = _goal_mgr_from_request(request)
    raw_max_turns = request.get("maxTurns")
    if raw_max_turns is None:
        state = mgr.set(goal)
    else:
        try:
            max_turns = int(raw_max_turns)
        except (TypeError, ValueError) as exc:
            raise WorkerError("maxTurns must be a positive integer.", code="bad_request") from exc
        if max_turns <= 0:
            raise WorkerError("maxTurns must be a positive integer.", code="bad_request")
        state = mgr.set(goal, max_turns=max_turns)
    return {"goal": _project_goal_state(state)}


def _goal_pause(request: dict[str, Any]) -> dict[str, Any]:
    reason = string_or_none(request.get("reason")) or "user-paused"
    mgr = _goal_mgr_from_request(request)
    return {"goal": _project_goal_state(mgr.pause(reason))}


def _goal_resume(request: dict[str, Any]) -> dict[str, Any]:
    mgr = _goal_mgr_from_request(request)
    return {"goal": _project_goal_state(mgr.resume())}


def _goal_clear(request: dict[str, Any]) -> dict[str, Any]:
    mgr = _goal_mgr_from_request(request)
    had_goal = bool(mgr.has_goal())
    mgr.clear()
    return {"cleared": had_goal}


def _goal_evaluate(request: dict[str, Any]) -> dict[str, Any]:
    response_text = string_or_none(request.get("responseText")) or ""
    mgr = _goal_mgr_from_request(request)
    decision = mgr.evaluate_after_turn(response_text)
    return _project_goal_decision(decision, mgr.state)


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

    # Inject parent task context for delegated subissues
    parent_task = request.get("parentTask")
    if isinstance(parent_task, dict):
        parent_title = string_or_none(parent_task.get("title")) or ""
        parent_id = string_or_none(parent_task.get("id")) or ""
        parent_desc = string_or_none(parent_task.get("description")) or ""
        ctx_block = f"---\nThis task is a DELEGATED SUBISSUE of the parent task below. Context is provided for reference.\n"
        ctx_block += f"Parent Task: {parent_title}\nParent ID: {parent_id}\n"
        if parent_desc and len(parent_desc) > 200:
            ctx_block += f"Parent Description: {parent_desc[:200]}...\n"
        elif parent_desc:
            ctx_block += f"Parent Description: {parent_desc}\n"
        ctx_block += "Complete this subissue autonomously. If you create sub-subissues, mark them as child tasks of the parent.\n---"
        system_message = f"{ctx_block}\n\n{system_message}" if system_message else ctx_block

    delegated_task_id = string_or_none(request.get("delegatedTaskId"))

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
    _register_active_agent(_task_key_for(request), request_id, agent)
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

    if result.get("interrupted"):
        # User-initiated stop: end the turn cleanly (the partial reply is already
        # streamed and persisted by run_conversation) rather than as an error.
        _send({
            "id": request_id,
            "type": "done",
            "sessionId": getattr(agent, "session_id", None) or session_id,
            "interrupted": True,
            "model": string_or_none(getattr(agent, "model", None)),
            "provider": string_or_none(getattr(agent, "_minions_resolved_provider", None)),
        })
        return

    final_text = str(result.get("final_response") or "")
    failure_message = _agent_failure_message(final_text)
    if failure_message:
        raise WorkerError(failure_message, code="provider_error")

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
    _send({
        "id": request_id,
        "type": "done",
        "sessionId": getattr(agent, "session_id", None) or session_id,
        "context": context,
        "model": string_or_none(getattr(agent, "model", None)),
        "provider": string_or_none(getattr(agent, "_minions_resolved_provider", None)),
    })


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
    final_text = str(result.get("final_response") or "")
    failure_message = _agent_failure_message(final_text)
    if failure_message:
        raise WorkerError(failure_message, code="provider_error")
    return final_text


def _submit_background_agent_request(
    request_id: str,
    request: dict[str, Any],
    *,
    name_prefix: str,
    handler: Callable[[dict[str, Any]], dict[str, Any]],
    task_key: str | None = None,
) -> None:
    if task_key and not _try_mark_task_active(task_key, request_id):
        _send_error(
            request_id,
            WorkerError(
                "This task is already running. Wait for the current operation to finish, then retry.",
                code="task_busy",
            ),
        )
        return

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
            if task_key:
                _clear_task_active(task_key, request_id)

    threading.Thread(
        target=runner,
        daemon=True,
        name=f"{name_prefix}-{request_id[:8]}",
    ).start()


def _run_compress(request: dict[str, Any]) -> dict[str, Any]:
    """Manually compress a session's conversation history."""
    session_id = string_or_none(request.get("sessionId"))
    if not session_id:
        raise WorkerError("Session ID is required.", code="bad_request")

    focus_topic = string_or_none(request.get("focusTopic"))
    settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
    requested_model = string_or_none(settings.get("model"))
    requested_effort = _normalize_reasoning(settings.get("reasoningEffort"))

    session_db, live_session_id = open_session(session_id)
    history = load_agent_history(session_db, live_session_id)
    if len(history) < 4:
        raise WorkerError("Conversation too short to compact.", code="compact_skipped")

    agent = _create_agent(
        session_id=live_session_id,
        requested_model=requested_model,
        reasoning_effort=requested_effort,
    )

    context_compressor = getattr(agent, "context_compressor", None)
    if not context_compressor:
        raise WorkerError("Context compression is not available for this model.", code="compact_unavailable")

    has_content_to_compress = getattr(context_compressor, "has_content_to_compress", None)
    if callable(has_content_to_compress) and not has_content_to_compress(history):
        raise WorkerError("Conversation has nothing to compact yet.", code="compact_skipped")

    current_tokens = int(request.get("currentTokens") or 0)
    if not current_tokens:
        context_length = int(getattr(context_compressor, "context_length", 0) or 0)
        current_tokens = context_length or 100000

    system_message = string_or_none(request.get("systemMessage")) or ""
    prev_count = len(history)

    compressed, _ = agent._compress_context(
        history,
        system_message,
        approx_tokens=current_tokens,
        task_id=live_session_id,
        focus_topic=focus_topic or None,
    )

    flush = getattr(agent, "_flush_messages_to_session_db", None)
    if callable(flush):
        flush(compressed, conversation_history=[])

    new_session_id = getattr(agent, "session_id", live_session_id)
    context_window = int(getattr(context_compressor, "context_length", 0) or 0)
    context_used = int(getattr(context_compressor, "last_prompt_tokens", 0) or 0)

    return {
        "compressed": True,
        "sessionId": new_session_id,
        "previousMessageCount": prev_count,
        "compressedMessageCount": len(compressed),
        "context": {
            "used_tokens": context_used,
            "window_tokens": context_window,
        } if context_window > 0 else None,
    }


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
        elif request_type == "scheduledTasks.list":
            _result(request_id, list_scheduled_tasks(bool(request.get("includeDisabled"))))
        elif request_type == "scheduledTasks.get":
            _result(request_id, get_scheduled_task(request.get("scheduledTaskId")))
        elif request_type == "scheduledTasks.create":
            _result(request_id, create_scheduled_task(request))
        elif request_type == "scheduledTasks.update":
            _result(request_id, update_scheduled_task(request))
        elif request_type == "scheduledTasks.pause":
            _result(request_id, pause_scheduled_task(request.get("scheduledTaskId"), request.get("reason")))
        elif request_type == "scheduledTasks.resume":
            _result(request_id, resume_scheduled_task(request.get("scheduledTaskId")))
        elif request_type == "scheduledTasks.run":
            _result(request_id, trigger_scheduled_task(request.get("scheduledTaskId")))
        elif request_type == "scheduledTasks.remove":
            _result(request_id, remove_scheduled_task(request.get("scheduledTaskId")))
        elif request_type == "scheduledTasks.tick":
            _result(request_id, {"executed": tick_scheduled_tasks()})
        elif request_type == "session.messages.get":
            _result(request_id, project_session_messages(request.get("sessionId"), request.get("taskId")))
        elif request_type == "session.get":
            _result(request_id, project_session_metadata(request.get("sessionId")))
        elif request_type == "goal.status":
            _result(request_id, _goal_status(request))
        elif request_type == "goal.set":
            _result(request_id, _goal_set(request))
        elif request_type == "goal.pause":
            _result(request_id, _goal_pause(request))
        elif request_type == "goal.resume":
            _result(request_id, _goal_resume(request))
        elif request_type == "goal.clear":
            _result(request_id, _goal_clear(request))
        elif request_type == "goal.evaluate":
            _submit_background_agent_request(request_id, request, name_prefix="goal", handler=_goal_evaluate)
        elif request_type == "chat.interrupt":
            _result(request_id, _interrupt_active_chat(request))
        elif request_type == "chat":
            _submit_chat_request(request_id, request)
        elif request_type == "session.compress":
            _submit_background_agent_request(
                request_id,
                request,
                name_prefix="compress",
                handler=_run_compress,
                task_key=_task_key_for(request),
            )
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
    start_scheduled_task_ticker()
    try:
        _run_loop()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
