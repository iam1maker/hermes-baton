"""baton backend — HTTP face of the baton daemon.

The desktop half polls this prefix (`/api/plugins/baton/...`) instead of the
daemon port directly: the renderer is same-origin with the gateway, so a plugin
route needs no CORS and no extra CSP allowance, and this layer is where the
daemon lifecycle lives (start on demand, self-heal, structured errors).

  /state     full snapshot: link state, device, battery, diagnostics, keys, config
  /events    incremental event stream (transcripts + native keys), `since` cursor
  /consume   take the pending transcript exactly once (polling fallback)
  /config    read / patch / reset the persisted settings
  /history   recent dictations (opt-in), DELETE clears
  /selftest  transcribe the bundled sample (no remote needed)
  /stt       speech-recognition status: models, engine, external service, job
  /stt/install  GET the install job record, POST to start one
  /logs      the daemon's last log lines
"""

from __future__ import annotations

import importlib.util
import sys
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import Response

ROUTER_VERSION = "1.0.0"

router = APIRouter()


def _runtime():
    """Import the shared supervisor once, by path, under a fixed module name.

    `runtime.py` sits at the plugin root so `__init__.py` (agent-side tool) and
    this dashboard router share one process-wide instance — one daemon, one
    spawn record, one atexit hook.
    """
    name = "hermes_baton_runtime"
    module = sys.modules.get(name)
    if module is not None:
        return module
    path = Path(__file__).resolve().parent.parent / "runtime.py"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _fail(error: Exception) -> HTTPException:
    return HTTPException(status_code=503, detail=str(error))


@router.get("/health")
def health() -> dict[str, Any]:
    """Daemon + environment facts; never raises so a broken install still reports."""
    return _runtime().diagnostics_bundle()


@router.get("/state")
def state() -> dict[str, Any]:
    try:
        return _runtime().state()
    except RuntimeError as error:
        raise _fail(error) from None


@router.get("/events")
def events(since: str = Query("head", description="last seen cursor, or 'head'")) -> dict[str, Any]:
    try:
        return _runtime().events(since)
    except RuntimeError as error:
        raise _fail(error) from None


@router.get("/devices")
def devices(seconds: int = Query(4, ge=2, le=10)) -> dict[str, Any]:
    """Candidate ATVV remotes: system-connected first, then whatever is advertising."""
    try:
        return _runtime().list_devices(seconds)
    except RuntimeError as error:
        raise _fail(error) from None


@router.post("/consume")
def consume() -> dict[str, Any]:
    try:
        return _runtime().consume()
    except RuntimeError as error:
        raise _fail(error) from None


@router.post("/start")
def start() -> dict[str, Any]:
    try:
        return _runtime().start()
    except RuntimeError as error:
        raise _fail(error) from None


@router.post("/stop")
def stop() -> dict[str, Any]:
    try:
        return _runtime().stop()
    except RuntimeError as error:
        raise _fail(error) from None


@router.post("/restart")
def restart() -> dict[str, Any]:
    try:
        return _runtime().restart()
    except RuntimeError as error:
        raise _fail(error) from None

@router.post("/devices/reload")
def reload_devices() -> dict[str, Any]:
    """Hot-reload the device-model registry: a new remote model = one JSON file, no daemon restart."""
    try:
        return _runtime().reload_devices()
    except RuntimeError as error:
        raise _fail(error) from None


@router.post("/key")
def inject_key(code: str = Body("", embed=True), down: bool = Body(True, embed=True)) -> dict[str, Any]:
    """Fake a remote key — the acceptance path that needs no hardware."""
    try:
        return _runtime().inject_key(code, down)
    except RuntimeError as error:
        raise _fail(error) from None


@router.get("/config")
def get_config() -> dict[str, Any]:
    try:
        return _runtime().get_config()
    except RuntimeError as error:
        raise _fail(error) from None


@router.post("/config")
def set_config(payload: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    runtime = _runtime()
    try:
        if payload.get("reset") is True:
            return runtime.reset_config()
        patch = payload.get("patch")
        if not isinstance(patch, dict):
            patch = {key: value for key, value in payload.items() if key != "reset"}
        return runtime.patch_config(patch)
    except RuntimeError as error:
        raise _fail(error) from None


@router.get("/history")
def history(limit: int = Query(50, ge=1, le=500)) -> dict[str, Any]:
    try:
        return _runtime().history(limit)
    except RuntimeError as error:
        raise _fail(error) from None


@router.delete("/history")
def clear_history() -> dict[str, Any]:
    try:
        return _runtime().clear_history()
    except RuntimeError as error:
        raise _fail(error) from None


@router.post("/selftest")
def selftest() -> dict[str, Any]:
    try:
        return _runtime().selftest()
    except RuntimeError as error:
        raise _fail(error) from None


@router.get("/stt")
def stt() -> dict[str, Any]:
    """Speech-recognition status: local models, native engine, external service, install job."""
    try:
        return _runtime().stt()
    except RuntimeError as error:
        raise _fail(error) from None


@router.post("/stt/install")
def install_stt(payload: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    """Start the background install job (models and/or the sherpa engine); poll GET /stt/install."""
    what = str(payload.get("what") or "all")
    fp32 = bool(payload.get("fp32", False))
    try:
        return _runtime().install_stt(what, fp32)
    except RuntimeError as error:
        raise _fail(error) from None


@router.get("/stt/install")
def stt_install() -> dict[str, Any]:
    """The current or most recent install job (job is null until one runs)."""
    try:
        return _runtime().stt_install_job()
    except RuntimeError as error:
        raise _fail(error) from None


@router.post("/mock/transcript")
def mock_transcript(payload: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    """Same shape as a real dictation, so the composer path can be tested without hardware."""
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="missing text")
    try:
        return _runtime().mock_transcript(text)
    except RuntimeError as error:
        raise _fail(error) from None


@router.post("/capture")
def capture(payload: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    """Wait for one real utterance: press the remote's voice key inside the window."""
    try:
        return _runtime().capture(int(payload.get("waitMs") or 12000))
    except RuntimeError as error:
        raise _fail(error) from None


@router.post("/open/settings")
def open_settings(payload: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    """Open a macOS privacy pane (the Bluetooth grant the BLE bridge needs)."""
    pane = str(payload.get("pane") or "bluetooth")
    if pane not in ("bluetooth", "microphone"):
        raise HTTPException(status_code=400, detail=f"unknown pane: {pane}")
    try:
        return _runtime().open_settings(pane)
    except RuntimeError as error:
        raise _fail(error) from None


@router.get("/logs")
def logs(lines: int = Query(80, ge=1, le=400)) -> dict[str, Any]:
    try:
        return _runtime().daemon_logs(lines)
    except RuntimeError as error:
        raise _fail(error) from None


@router.get("/audio/last")
def last_audio() -> Response:
    """The last utterance as WAV, so the page can play back what it heard."""
    runtime = _runtime()
    ok, error = runtime.ensure_running()
    if not ok:
        raise HTTPException(status_code=503, detail=error or "daemon is not running")
    url = f"{runtime.BASE}/audio/last"
    token = runtime._token()  # noqa: SLF001 — same package
    request = urllib.request.Request(url, headers={"authorization": f"Bearer {token}"} if token else {})
    try:
        with urllib.request.urlopen(request, timeout=6) as response:
            payload = response.read()
    except Exception as request_error:  # noqa: BLE001 — 404 means "nothing recorded yet"
        raise HTTPException(status_code=404, detail=f"no recording yet: {request_error}") from None
    return Response(content=payload, media_type="audio/wav", headers={"cache-control": "no-store"})
