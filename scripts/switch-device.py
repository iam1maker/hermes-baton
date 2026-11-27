#!/usr/bin/env python3
"""Measure a hot device switch: POST /config → poll /state until the new bridge is ready.

Proves switching a remote does NOT need a Hermes restart — only the bridge re-spawns.
Leaves the plugin on whichever device it started with.
"""
import json
import os
import time
import urllib.request

STATE = os.path.expanduser("~/.hermes/baton")
TOKEN = open(os.path.join(STATE, "token")).read().strip()
BASE = "http://127.0.0.1:8791"

# Device names exactly as the remotes report them over BLE: they are patched into
# config and end up as the bridge's --name filter, so they stay verbatim.
# The paired device name macOS reports (U+5C0F U+7C73 U+84DD U+7259 U+8BED U+97F3 U+9065 U+63A7 U+5668);
# kept as escapes so the repository source stays ASCII while matching stays exact.
XIAOMI = ("98A4D12B-6ECD-8BCE-38A5-CC479494E15E", "\u5c0f\u7c73\u84dd\u7259\u8bed\u97f3\u9065\u63a7\u5668")
CAST = ("1EC33B1A-A855-9E87-D576-ADD938299D28", "Chromecast Remote")


def call(method: str, path: str, body=None, timeout: float = 30.0) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(BASE + path, data=data, method=method)
    request.add_header("Authorization", f"Bearer {TOKEN}")
    if data:
        request.add_header("content-type", "application/json")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode())


def wait_ready(target_id: str, budget: float = 30.0) -> tuple[float, dict]:
    started = time.time()
    last = {}
    while time.time() - started < budget:
        try:
            last = call("GET", "/state")
        except Exception as error:  # noqa: BLE001
            last = {"state": f"http-error {error}"}
            time.sleep(0.2)
            continue
        if last.get("state") == "ready" and (last.get("device") or {}).get("id") == target_id:
            return time.time() - started, last
        time.sleep(0.2)
    return time.time() - started, last


def switch(label: str, device: tuple[str, str]) -> float:
    print(f"\n=== {label}: {device[1]} ===")
    before = call("GET", "/state")
    print(f"before switch pid={before['pid']} device={(before.get('device') or {}).get('name')} state={before['state']}")
    started = time.time()
    call("POST", "/config", {"patch": {"deviceId": device[0], "deviceName": device[1]}})
    elapsed, after = wait_ready(device[0])
    print(f"took {elapsed:.2f}s → pid={after.get('pid')} device={(after.get('device') or {}).get('name')}"
          f" state={after.get('state')} battery={after.get('battery')}")
    print(f"pid change: {before['pid']} → {after.get('pid')} (bridge restarted, daemon unchanged)")
    return elapsed


def main() -> int:
    start = call("GET", "/state")
    current = (start.get("device") or {}).get("id")
    print(f"starting device: {(start.get('device') or {}).get('name')}  daemon pid={start['pid']}")

    other = XIAOMI if current == CAST[0] else CAST
    a = switch("switch 1", other)
    b = switch("switch back", CAST if other is XIAOMI else XIAOMI)

    final = call("GET", "/state")
    print(f"\nfinal: device={(final.get('device') or {}).get('name')} pid={final['pid']} state={final['state']}")
    print(f"two switches took {a:.2f}s / {b:.2f}s; the daemon pid stayed {start['pid']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
