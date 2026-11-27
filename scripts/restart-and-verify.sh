#!/bin/bash
# Restart the Hermes gateway (so the freshly written plugin_api.py is re-imported and the
# /api/plugins/baton/* router is rebuilt), then verify the plugin end to end.
#
# Launched by launchd (RunAtLoad, one-shot) rather than from an agent tool call: the restart
# must outlive the gateway process that spawned the caller. It waits 75s first so the caller's
# reply is delivered before the gateway blips.
set -u

# Every path is discovered or overridable; nothing here may assume the author's layout.
APP_ROOT="${HERMES_APP_ROOT:-$HOME/.hermes}"
PROFILE="${HERMES_HOME:-$APP_ROOT}"
PLUGIN_DIR="${BATON_PLUGIN_DIR:-$PROFILE/plugins/baton}"
LOG="${BATON_LOG:-$PLUGIN_DIR/restart-verify.log}"
PY="${BATON_PY:-$(ls -d "$APP_ROOT"/tools/python-3*/bin/python3 2>/dev/null | head -1)}"
SP="${BATON_SP:-$(ls -d "$APP_ROOT"/installs/*/environments/*/venv/lib/python3*/site-packages 2>/dev/null | head -1)}"
HERMES="${BATON_HERMES:-$APP_ROOT/hermes-agent/.hermes/bin/hermes}"

{
  echo
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') restart-and-verify: waiting 75s ==="
  sleep 75

  echo "--- gateway restart ---"
  HERMES_HOME="$PROFILE" "$HERMES" gateway restart 2>&1 | tail -20
  echo "restart exit: $?"

  echo "--- waiting for the control socket ---"
  for i in $(seq 1 40); do
    if [ -S "$HOME/.hermes/gateway.sock" ]; then
      echo "socket up after ${i}s"
      break
    fi
    sleep 1
  done
  sleep 3

  if [ ! -S "$HOME/.hermes/gateway.sock" ]; then
    echo "!! socket missing — falling back to 'gateway start'"
    HERMES_HOME="$PROFILE" "$HERMES" gateway start 2>&1 | tail -20
    sleep 8
  fi

  echo "--- plugin routes ---"
  PYTHONPATH="$SP" "$PY" "$PLUGIN_DIR/scripts/verify-gateway.py" 2>&1
  echo "verify exit: $?"

  echo "--- daemon tail ---"
  tail -12 "$HOME/.hermes/baton/daemon.out" 2>/dev/null
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') done ==="
} >>"$LOG" 2>&1

# One-shot job: unload itself so it never runs again.
launchctl bootout "gui/$(id -u)/cc.1maker.rm-verify" >/dev/null 2>&1
exit 0
