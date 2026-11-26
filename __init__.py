"""指挥 (baton) — BLE voice remotes as a first-class Hermes input surface.

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
        raise RuntimeError("baton: runtime.py 无法加载")
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
        "蓝牙语音遥控器的本地链路（小米 / Chromecast 等，型号见 sidecar/devices）。status 看链路/电量/最近一次转写；"
        "history 读语音输入历史；consume 取走尚未被消费的一条转写；"
        "start/stop/restart 控制蓝牙抓音；selftest 用自带样本跑一遍识别（不需要遥控器）；"
        "config 读取或修改设置（gapMs/language/keyMap/phrases/autoSend 等）；"
        "key 注入一个遥控器按键用于自测。语音是本地 SenseVoice 识别的，音频不出本机。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["status", "history", "consume", "start", "stop", "restart", "selftest", "config", "key"],
                "description": "要做的事，默认 status",
            },
            "limit": {"type": "integer", "description": "history 返回条数（1-200），默认 20"},
            "patch": {
                "type": "object",
                "description": "config 时要写入的设置，键值对，例如 {\"language\": \"zh\", \"autoSend\": false}",
            },
            "reset": {"type": "boolean", "description": "config 时恢复默认设置"},
            "code": {"type": "string", "description": "key 时的按键名，如 Enter / Back / Home"},
            "down": {"type": "boolean", "description": "key 时是按下还是抬起，默认 true"},
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
    lines = [f"链路: {service}"]
    if snapshot.get("detail"):
        lines[0] += f"（{snapshot['detail']}）"
    if device.get("name") or device.get("id"):
        lines.append(f"设备: {device.get('name') or '?'} [{device.get('id') or '?'}]")
    if diagnostics.get("battery") is not None:
        lines.append(f"电量: {diagnostics['battery']}%")
    if transcriber:
        lines.append(
            f"识别: {transcriber.get('backend') or 'sensevoice'}"
            f" / {transcriber.get('language') or config.get('language') or 'zh'}"
            f" / 模型 {transcriber.get('model') or '?'}"
        )
    if diagnostics.get("frames") is not None:
        lines.append(
            f"语音: {diagnostics.get('sessions')} 次会话 / {diagnostics.get('frames')} 帧"
            f" / 重连 {diagnostics.get('retries')}"
        )
    last = diagnostics.get("lastUtterance") or {}
    if last.get("text"):
        lines.append(f"最近一次: 「{last['text']}」({round((last.get('audioMs') or 0) / 1000, 1)}s 音频)")
    pending = snapshot.get("pending")
    if pending:
        lines.append(f"待消费转写: 「{pending.get('text')}」")
    if diagnostics.get("lastError"):
        lines.append(f"最近错误: {diagnostics['lastError']}")
    if snapshot.get("keys"):
        lines.append(f"按键: {snapshot['keys']}")
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
                hint = "" if payload.get("enabled", True) else "（历史未开启：config history=true）"
                return f"还没有语音输入记录{hint}"
            rows = []
            for entry in entries:
                stamp = (entry.get("at") or "")[:19].replace("T", " ")
                text = (entry.get("text") or "").replace("\n", " ")
                source = entry.get("source") or "remote"
                rows.append(f"- {stamp} [{source}] {text}")
            return f"{len(rows)} 条语音输入：\n" + "\n".join(rows)
        if action == "consume":
            payload = runtime.consume()
            pending = payload.get("transcript") or payload.get("pending")
            if not pending:
                return "当前没有待消费的转写"
            return f"「{pending.get('text')}」" if isinstance(pending, dict) else str(pending)
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
                return "自检没有识别出文字（模型或音频有问题，看 /logs）"
            cost = f"{float(inference) * 1000:.0f}ms 推理" if inference is not None else "推理耗时未知"
            length = f"{float(audio):.1f}s 音频" if audio else "样本音频"
            return f"自检通过：{length}，{cost} → 「{text}」"
        if action == "config":
            if args.get("reset"):
                payload = runtime.reset_config()
            elif isinstance(args.get("patch"), dict) and args["patch"]:
                payload = runtime.patch_config(args["patch"])
            else:
                payload = runtime.get_config()
            values = payload.get("values") or payload
            return "当前设置：\n" + json.dumps(values, ensure_ascii=False, indent=2, sort_keys=True)
        if action == "key":
            code = args.get("code") or "Enter"
            payload = runtime.inject_key(code, bool(args.get("down", True)))
            return f"已注入按键 {code}：{json.dumps(payload, ensure_ascii=False)}"
        return f"未知 action: {action}"
    except RuntimeError as error:
        return f"baton 出错：{error}"
    except Exception as error:  # noqa: BLE001 — a tool must return text, never explode
        return f"baton 异常：{type(error).__name__}: {error}"


def register(ctx) -> None:
    """Register the agent-side tool. The desktop UI is loaded separately."""
    if not _supported():
        return
    ctx.register_tool(
        name="baton",
        toolset="baton",
        schema=REMOTE_MIC_SCHEMA,
        handler=handle_baton,
        description="从蓝牙语音遥控器读取语音输入（本地 SenseVoice 识别）与按键动作",
        emoji="🎙️",
    )
    ctx.on_unload(lambda: _runtime()._shutdown())  # noqa: SLF001 — one supervisor, one hook
