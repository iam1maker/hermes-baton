#!/usr/bin/env python3
"""Probe the live gateway's /api/plugins/baton/* routes the way the Desktop shell does.

Mints a single-use native-http ticket over the gateway control socket (the same path
ctx.rest takes in the renderer), then issues real HTTP requests. Exit code 0 = all green.

Usage: verify-gateway.py [--open-settings]
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERMES_REPO = Path("/Users/1maker/.hermes/hermes-agent")
HOME = Path("/Users/1maker/.hermes/profiles/forge")
sys.path.insert(0, str(HERMES_REPO))

from hermes_cli.gateway_client import _session_ticket  # noqa: E402
from hermes_cli.gateway_runtime_attach import attach_gateway  # noqa: E402


def main() -> int:
    attach = attach_gateway(HOME, start=False, timeout=20)
    if not attach.receipt.endpoint:
        print(f"gateway not reachable: {attach.receipt.state} {attach.receipt.reason_code}")
        return 2
    # The port changes on every restart, so read it from the attach receipt, never hardcode it.
    base = attach.receipt.endpoint.api_origin
    print(f"origin   {base}")

    def call(path: str, method: str = "GET", body=None, timeout: float = 60):
        request = urllib.request.Request(base + path, method=method)
        # A ticket is single-use: mint one per request.
        request.add_header(
            "x-hermes-gateway-ticket",
            _session_ticket(HOME, attach.receipt.endpoint, purpose="native-http", scope="profile"),
        )
        request.add_header("accept", "application/json")
        if body is not None:
            request.add_header("content-type", "application/json")
            request.data = json.dumps(body).encode()
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    failures = 0
    status, raw = call("/api/plugins/baton/health")
    print(f"health   {status} {raw[:120].decode('utf-8', 'replace')}")
    failures += status != 200

    status, raw = call("/api/plugins/baton/state")
    if status == 200:
        state = json.loads(raw)
        print(f"state    {status} service={state.get('state')} detail={state.get('detail')}")
        print(f"         model={(state.get('transcriber') or {}).get('model')}")
    else:
        print(f"state    {status} {raw[:160].decode('utf-8', 'replace')}")
        failures += 1

    status, raw = call("/api/plugins/baton/selftest", "POST")
    print(f"selftest {status} {raw[:200].decode('utf-8', 'replace')}")
    failures += status != 200

    status, raw = call("/api/plugins/baton/mock/transcript", "POST", {"text": "acceptance probe"})
    print(f"mock     {status} {raw[:160].decode('utf-8', 'replace')}")
    failures += status != 200

    # Exercises the new route without opening a System Settings window.
    status, raw = call("/api/plugins/baton/open/settings", "POST", {"pane": "nope"})
    print(f"settings {status} (expect 400 = route mounted, no window opened) {raw[:80].decode('utf-8', 'replace')}")
    failures += status != 400

    if "--open-settings" in sys.argv:
        status, raw = call("/api/plugins/baton/open/settings", "POST", {"pane": "bluetooth"})
        print(f"open-bt  {status} {raw[:80].decode('utf-8', 'replace')}")

    print("RESULT", "PASS" if failures == 0 else f"FAIL ({failures})")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
