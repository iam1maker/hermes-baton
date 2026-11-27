"""baton — BLE voice remotes as a first-class Hermes input surface.

The desktop half (`desktop/plugin.js`) turns a remote press into text inside the
composer. This half gives the *agent* the same door: read what was dictated, see
whether the link is healthy, and drive the daemon when something is stuck.

Design: the renderer owns the keyboard→action path because actions must hit the
focused composer in-process (`host.composer.insertText`). The daemon owns
Bluetooth + ASR. Python (this file, `runtime.py`, `dashboard/plugin_api.py`) is
only supervision and transport — no audio, no BLE, no model loading here.
"""

from __future__ import annotations

import importlib.util
import json
import platform
import sys
from pathlib import Path
from typing import Any

PLUGIN_DIR = Path(__file__).resolve().parent

_TOOL_MEMO: dict[str, Any] = {}


def _runtime():
    """The shared supervisor instance (same module object as the dashboard router)."""
    name = "hermes_baton_runtime"
    module = sys.modules.get(name)
    if module is not None:
        return module
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "runtime.py")
    if spec is None or spec.loader is None:  # pragma: no cover — packaged install
        raise RuntimeError("baton: cannot load runtime.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _supported() -> bool:
    """BLE bridge is a macOS binary (CoreBluetooth), so the tool only exists there."""
    return platform.system().lower() == "darwin"


REMOTE_MIC_SCHEMA: dict[str, Any] = {
    "name": "baton",
    "description": (
        "Local link to a Bluetooth voice remote (Xiaomi / Chromecast etc.; models in sidecar/devices). "
        "status shows link/battery/last transcript; history reads voice-input history; "
        "consume takes one transcript that has not been consumed yet; "
        "start/stop/restart control Bluetooth capture; selftest runs recognition on a bundled sample "
        "(no remote needed); config reads or changes settings (gapMs/language/keyMap/phrases/autoSend etc.); "
        "key injects a remote key for self-test. Speech is recognized locally by SenseVoice, "
        "so audio never leaves this machine."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["status", "history", "consume", "start", "stop", "restart", "selftest", "config", "key"],
                "description": "What to do; defaults to status",
            },
            "limit": {"type": "integer", "description": "How many entries history returns (1-200); default 20"},
            "patch": {
                "type": "object",
                "description": "Settings to write when action=config, as key/value pairs, e.g. {\"language\": \"zh\", \"autoSend\": false}",
            },
            "reset": {"type": "boolean", "description": "Restore default settings when action=config"},
            "code": {"type": "string", "description": "Key name for action=key, e.g. Enter / Back / Home"},
            "down": {"type": "boolean", "description": "Whether action=key is a press or a release; default true"},
        },
        "required": [],
    },
}


def _fmt_state(snapshot: dict) -> str:
    service = snapshot.get("state") or "unknown"
    device = snapshot.get("device") or {}
    diagnostics = snapshot.get("diagnostics") or {}
    transcriber = snapshot.get("transcriber") or {}
    config = snapshot.get("config") or {}
    lines = [f"link: {service}"]
    if snapshot.get("detail"):
        lines[0] += f" ({snapshot['detail']})"
    if device.get("name") or device.get("id"):
        lines.append(f"device: {device.get('name') or '?'} [{device.get('id') or '?'}]")
    if diagnostics.get("battery") is not None:
        lines.append(f"battery: {diagnostics['battery']}%")
    if transcriber:
        lines.append(
            f"transcriber: {transcriber.get('backend') or 'sensevoice'}"
            f" / {transcriber.get('language') or config.get('language') or 'zh'}"
            f" / model {transcriber.get('model') or '?'}"
        )
    if diagnostics.get("frames") is not None:
        lines.append(
            f"voice: {diagnostics.get('sessions')} session(s) / {diagnostics.get('frames')} frame(s)"
            f" / {diagnostics.get('retries')} reconnect(s)"
        )
    last = diagnostics.get("lastUtterance") or {}
    if last.get("text"):
        lines.append(f"last: \"{last['text']}\" ({round((last.get('audioMs') or 0) / 1000, 1)}s audio)")
    pending = snapshot.get("pending")
    if pending:
        lines.append(f"pending transcript: \"{pending.get('text')}\"")
    if diagnostics.get("lastError"):
        lines.append(f"last error: {diagnostics['lastError']}")
    if snapshot.get("keys"):
        lines.append(f"keys: {snapshot['keys']}")
    return "\n".join(lines)


def handle_baton(args: dict[str, Any], **_kw) -> str:
    action = (args.get("action") or "status").strip().lower()
    try:
        runtime = _runtime()
        if action == "status":
            return _fmt_state(runtime.state())
        if action == "history":
            limit = int(args.get("limit") or 20)
            payload = runtime.history(limit)
            entries = payload.get("entries") or payload.get("history") or []
            if not entries:
                hint = "" if payload.get("enabled", True) else " (history is off: config history=true)"
                return f"No voice input recorded yet{hint}"
            rows = []
            for entry in entries:
                stamp = (entry.get("at") or "")[:19].replace("T", " ")
                text = (entry.get("text") or "").replace("\n", " ")
                source = entry.get("source") or "remote"
                rows.append(f"- {stamp} [{source}] {text}")
            return f"{len(rows)} voice input entries:\n" + "\n".join(rows)
        if action == "consume":
            payload = runtime.consume()
            pending = payload.get("transcript") or payload.get("pending")
            if not pending:
                return "No pending transcript"
            return f"\"{pending.get('text')}\"" if isinstance(pending, dict) else str(pending)
        if action in {"start", "stop", "restart"}:
            payload = getattr(runtime, action)()
            return _fmt_state(payload) if isinstance(payload, dict) and payload.get("state") else json.dumps(payload, ensure_ascii=False)
        if action == "selftest":
            payload = runtime.selftest()
            entry = payload.get("transcript") or {}
            text = str(entry.get("text") or "").strip()
            inference = entry.get("inferenceSeconds")
            audio = entry.get("audioSeconds")
            if not text:
                return "Selftest produced no text (model or audio problem — check /logs)"
            cost = f"{float(inference) * 1000:.0f}ms inference" if inference is not None else "inference time unknown"
            length = f"{float(audio):.1f}s audio" if audio else "sample audio"
            return f"Selftest passed: {length}, {cost} -> \"{text}\""
        if action == "config":
            if args.get("reset"):
                payload = runtime.reset_config()
            elif isinstance(args.get("patch"), dict) and args["patch"]:
                payload = runtime.patch_config(args["patch"])
            else:
                payload = runtime.get_config()
            values = payload.get("values") or payload
            return "Current settings:\n" + json.dumps(values, ensure_ascii=False, indent=2, sort_keys=True)
        if action == "key":
            code = args.get("code") or "Enter"
            payload = runtime.inject_key(code, bool(args.get("down", True)))
            return f"Injected key {code}: {json.dumps(payload, ensure_ascii=False)}"
        return f"Unknown action: {action}"
    except RuntimeError as error:
        return f"baton error: {error}"
    except Exception as error:  # noqa: BLE001 — a tool must return text, never explode
        return f"baton exception: {type(error).__name__}: {error}"


def register(ctx) -> None:
    """Register the agent-side tool. The desktop UI is loaded separately."""
    if not _supported():
        return
    ctx.register_tool(
        name="baton",
        toolset="baton",
        schema=REMOTE_MIC_SCHEMA,
        handler=handle_baton,
        description="Read voice input (local SenseVoice) and key presses from a BLE voice remote",
        emoji="🎙️",
    )
    ctx.on_unload(lambda: _runtime()._shutdown())  # noqa: SLF001 — one supervisor, one hook
