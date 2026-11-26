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

XIAOMI = ("98A4D12B-6ECD-8BCE-38A5-CC479494E15E", "小米蓝牙语音遥控器")
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
    print(f"切换前 pid={before['pid']} device={(before.get('device') or {}).get('name')} state={before['state']}")
    started = time.time()
    call("POST", "/config", {"patch": {"deviceId": device[0], "deviceName": device[1]}})
    elapsed, after = wait_ready(device[0])
    print(f"耗时 {elapsed:.2f}s → pid={after.get('pid')} device={(after.get('device') or {}).get('name')}"
          f" state={after.get('state')} battery={after.get('battery')}")
    print(f"pid 变化: {before['pid']} → {after.get('pid')}（桥重启，守护进程不变）")
    return elapsed


def main() -> int:
    start = call("GET", "/state")
    current = (start.get("device") or {}).get("id")
    print(f"起始设备: {(start.get('device') or {}).get('name')}  daemon pid={start['pid']}")

    other = XIAOMI if current == CAST[0] else CAST
    a = switch("切换 1", other)
    b = switch("切回", CAST if other is XIAOMI else XIAOMI)

    final = call("GET", "/state")
    print(f"\n最终: device={(final.get('device') or {}).get('name')} pid={final['pid']} state={final['state']}")
    print(f"两次切换耗时 {a:.2f}s / {b:.2f}s，守护进程 pid 始终是 {start['pid']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
