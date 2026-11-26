"""Supervisor + client for the baton Node daemon.

One long-lived Node process (`sidecar/server.mjs`) owns the CoreBluetooth link,
the ATVV/ADPCM front-end and the local SenseVoice model. This module is the only
door the Python side uses: it starts the daemon on demand, self-heals a stale
token, and exposes typed helpers over its loopback HTTP API.

Why not start it from `__init__.py` at import time: the gateway imports every
enabled plugin on every launch, and spawning a BLE scanner for a user who never
touches the remote is worse than paying ~120 ms on the first request. Every
entry point calls `ensure_running()`.
"""

from __future__ import annotations

import atexit
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

PLUGIN_DIR = Path(__file__).resolve().parent
SIDECAR_DIR = PLUGIN_DIR / "sidecar"
SERVER_JS = SIDECAR_DIR / "server.mjs"
BRIDGE_BIN = SIDECAR_DIR / "bin" / "atvv-link"

STATE_DIR = Path(
    os.environ.get("BATON_STATE_DIR")
    or os.environ.get("REMOTE_MIC_STATE_DIR")
    or (Path.home() / ".hermes" / "baton")
)
PORT = int(os.environ.get("REMOTE_MIC_PORT") or 8791)
BASE = f"http://127.0.0.1:{PORT}"

_SPAWNED: subprocess.Popen | None = None
_LAST_ERROR: str | None = None
_SELF_HEALED = False


# ── process plumbing ─────────────────────────────────────────────────────────


def _node_binary() -> str | None:
    for candidate in (
        os.environ.get("REMOTE_MIC_NODE"),
        shutil.which("node"),
        str(Path.home() / ".local" / "bin" / "node"),
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ):
        if candidate and Path(candidate).exists():
            return str(candidate)
    return None


def _token() -> str | None:
    try:
        value = (STATE_DIR / "token").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def _request(method: str, path: str, body: Any = None, timeout: float = 6.0) -> dict:
    """Call the daemon. Raises RuntimeError with an actionable message on failure."""
    token = _token()
    url = f"{BASE}{path}"
    data = None
    headers = {"accept": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
        return json.loads(payload.decode("utf-8")) if payload else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:400]
        try:
            parsed = json.loads(detail)
            detail = parsed.get("error") or detail
        except Exception:
            pass
        raise RuntimeError(f"{method} {path} → HTTP {error.code}: {detail}") from None
    except urllib.error.URLError as error:
        raise RuntimeError(f"baton 守护进程不可达（{error.reason}）") from None
    except TimeoutError:
        raise RuntimeError(f"{method} {path} 超时（{timeout}s）") from None


def _health() -> dict | None:
    try:
        with urllib.request.urlopen(f"{BASE}/health", timeout=1.5) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        return None


def _looks_like_ours(pid: int) -> bool:
    """True when `pid` really is our daemon (never kill a stranger on the port)."""
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True, text=True, timeout=3,
        ).stdout
    except Exception:
        return False
    return "baton/sidecar/server.mjs" in out or "remote-mic/sidecar/server.mjs" in out or "sidecar/server.mjs" in out


def _spawn() -> subprocess.Popen:
    node = _node_binary()
    if node is None:
        raise RuntimeError("找不到 node（需要 Node.js ≥ 22；或设 REMOTE_MIC_NODE 指向它）")
    if not SERVER_JS.exists():
        raise RuntimeError(f"守护进程脚本缺失：{SERVER_JS}")
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    log_path = STATE_DIR / "daemon.out"
    env = os.environ.copy()
    env["REMOTE_MIC_STATE_DIR"] = str(STATE_DIR)
    env["REMOTE_MIC_PORT"] = str(PORT)
    env["REMOTE_MIC_PARENT_PID"] = str(os.getpid())
    # The daemon is a child of the gateway: die with it, never outlive a restart.
    process = subprocess.Popen(  # noqa: S603 — fixed argv, no shell
        [node, str(SERVER_JS)],
        cwd=str(SIDECAR_DIR),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=open(log_path, "ab"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return process


def ensure_running(timeout: float = 12.0) -> tuple[bool, str | None]:
    """Start the daemon if it is not already answering. Returns (ok, error)."""
    global _SPAWNED, _LAST_ERROR, _SELF_HEALED

    if _health() is not None:
        # Port is live. Verify we can actually authenticate against it.
        try:
            _request("GET", "/state", timeout=3)
            return True, None
        except RuntimeError as error:
            if "HTTP 401" not in str(error) or _SELF_HEALED:
                return False, str(error)
            # A daemon from an older state dir holds the port with another token.
            health = _health() or {}
            pid = int(health.get("pid") or 0)
            if not pid or not _looks_like_ours(pid):
                return False, "端口被别的进程占着，且不是 baton 守护进程"
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError as kill_error:
                return False, f"无法结束旧的守护进程 {pid}：{kill_error}"
            _SELF_HEALED = True
            deadline = time.time() + 5
            while time.time() < deadline and _health() is not None:
                time.sleep(0.2)

    if _SPAWNED is not None and _SPAWNED.poll() is not None:
        code = _SPAWNED.returncode
        _SPAWNED = None
        _LAST_ERROR = f"守护进程退出（code={code}），见 {STATE_DIR / 'daemon.out'}"

    if _SPAWNED is None:
        try:
            _SPAWNED = _spawn()
        except RuntimeError as error:
            _LAST_ERROR = str(error)
            return False, _LAST_ERROR

    deadline = time.time() + timeout
    while time.time() < deadline:
        if _health() is not None:
            try:
                _request("GET", "/state", timeout=3)
                _LAST_ERROR = None
                return True, None
            except RuntimeError as error:
                _LAST_ERROR = str(error)
                return False, _LAST_ERROR
        if _SPAWNED.poll() is not None:
            _LAST_ERROR = (
                f"守护进程启动失败（code={_SPAWNED.returncode}），见 {STATE_DIR / 'daemon.out'}"
            )
            _SPAWNED = None
            return False, _LAST_ERROR
        time.sleep(0.15)
    _LAST_ERROR = f"守护进程在 {timeout:.0f}s 内没有就绪，见 {STATE_DIR / 'daemon.out'}"
    return False, _LAST_ERROR


def call(method: str, path: str, body: Any = None, timeout: float = 15.0) -> dict:
    """ensure_running() then the request; the only entry point the API uses."""
    ok, error = ensure_running()
    if not ok:
        raise RuntimeError(error or "baton 守护进程未运行")
    return _request(method, path, body, timeout=timeout)


# ── typed helpers ────────────────────────────────────────────────────────────


def state() -> dict:
    return call("GET", "/state")


def events(since: int | str = "head") -> dict:
    return call("GET", f"/events?since={since}")


def list_devices(seconds: int = 4) -> dict:
    """List candidate ATVV remotes (system-connected + advertising).

    The daemon shells out to the bridge's `--list` mode, so this blocks for
    roughly `seconds`; the timeout must stay above the scan window.
    """
    window = max(2, min(10, int(seconds)))
    return call("GET", f"/devices?seconds={window}", timeout=window + 16)


def consume() -> dict:
    return call("POST", "/consume", {})


def restart() -> dict:
    return call("POST", "/restart", {}, timeout=30)


def reload_devices() -> dict:
    """热重载设备型号注册表（内置 + 用户目录）。

    新增遥控器型号 = 丢一个 JSON 到 <state dir>/devices/ 再调这里，
    不用重启守护进程；当前型号或桥参数变了守护进程自己重启链路。
    """
    return call("POST", "/devices/reload", {}, timeout=30)


def start() -> dict:
    return call("POST", "/start", {}, timeout=20)


def stop() -> dict:
    return call("POST", "/stop", {}, timeout=20)


def inject_key(code: str, down: bool = True) -> dict:
    return call("POST", "/key", {"code": code, "down": down})


def get_config() -> dict:
    return call("GET", "/config")


def patch_config(patch: dict) -> dict:
    return call("POST", "/config", {"patch": patch}, timeout=30)


def reset_config() -> dict:
    return call("POST", "/config", {"reset": True}, timeout=30)


def history(limit: int = 50) -> dict:
    return call("GET", f"/history?limit={max(1, min(500, int(limit)))}")


def clear_history() -> dict:
    return call("DELETE", "/history")


def mock_transcript(text: str) -> dict:
    """Inject a transcript-shaped event — verifies the composer hand-off with no remote."""
    return call("POST", "/mock/transcript", {"text": text}, timeout=20)


def capture(wait_ms: int = 12000) -> dict:
    """Wait for the next real utterance (press the voice key during the window)."""
    return call("POST", "/capture", {"waitMs": int(wait_ms)}, timeout=(max(1500, min(30000, int(wait_ms))) / 1000) + 15)


def open_settings(pane: str = "bluetooth") -> dict:
    """Open a macOS privacy pane (the Bluetooth grant the bridge needs)."""
    return call("POST", "/open/settings", {"pane": pane}, timeout=15)


def selftest() -> dict:
    return call("POST", "/selftest", {}, timeout=120)


def daemon_logs(lines: int = 80) -> dict:
    return call("GET", f"/logs?lines={max(1, min(400, int(lines)))}")


def diagnostics_bundle() -> dict:
    """Everything a bug report needs, in one dict (never raises)."""
    info: dict[str, Any] = {
        "state_dir": str(STATE_DIR),
        "port": PORT,
        "server": str(SERVER_JS),
        "bridge": str(BRIDGE_BIN),
        "bridge_exists": BRIDGE_BIN.exists(),
        "node": _node_binary(),
        "last_error": _LAST_ERROR,
    }
    try:
        snapshot = state()
        info.update(
            {
                "ok": True,
                "daemon_pid": snapshot.get("pid"),
                "uptime_ms": snapshot.get("uptimeMs"),
                "service": snapshot.get("state"),
                "detail": snapshot.get("detail"),
                "device": snapshot.get("device"),
                "transcriber": snapshot.get("transcriber"),
                "diagnostics": snapshot.get("diagnostics"),
            }
        )
    except Exception as error:  # noqa: BLE001 — a diagnostic bundle must not raise
        info.update({"ok": False, "error": str(error)})
    return info


def _shutdown() -> None:
    """Kill the daemon we spawned when the gateway exits (never a stranger's)."""
    global _SPAWNED
    process = _SPAWNED
    _SPAWNED = None
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=3)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


atexit.register(_shutdown)
