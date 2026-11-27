#!/usr/bin/env bash
# Baton installer: install this repository as a plugin in a Hermes profile, and
# optionally install the desktop half.
#
#   bash scripts/install.sh                 # install into the default profile
#   bash scripts/install.sh forge           # install into the forge profile
#   bash scripts/install.sh forge --with-desktop
#
# It does exactly three things: copy the plugin directory, copy the desktop
# plugin (optional), and print the enable command you still have to run. It does
# not touch config.yaml, does not touch .env, and writes no secrets.
set -euo pipefail

PROFILE="${1:-default}"
WITH_DESKTOP="no"
DESKTOP_ONLY="no"
for arg in "$@"; do
  case "$arg" in
    --with-desktop) WITH_DESKTOP="yes" ;;
    --desktop-only) WITH_DESKTOP="yes"; DESKTOP_ONLY="yes" ;;
  esac
done

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_ID="baton"

if [ "$PROFILE" = "default" ]; then
  HERMES_HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
else
  HERMES_HOME_DIR="$HOME/.hermes/profiles/$PROFILE"
fi

if [ ! -d "$HERMES_HOME_DIR" ]; then
  echo "profile directory not found: $HERMES_HOME_DIR" >&2
  echo "Run Hermes once first, or check the profile name (ls ~/.hermes/profiles)" >&2
  exit 1
fi

PLUGINS_DIR="$HERMES_HOME_DIR/plugins"
DESKTOP_DIR="$HOME/.hermes/desktop-plugins/$PLUGIN_ID"
DEST="$PLUGINS_DIR/$PLUGIN_ID"

# The source directory may itself be the install directory (that is the case when
# developing inside a profile). In that case rm -rf would delete the source and
# the following cp would copy from an empty directory -- the whole repository
# would be gone. So skip the copy in that situation.
if [ "$DESKTOP_ONLY" = "no" ]; then
  if [ -d "$DEST" ] && [ "$(cd "$DEST" && pwd -P)" = "$(cd "$SRC" && pwd -P)" ]; then
    echo "-> source directory is the install directory ($DEST), skipping copy"
  else
    echo "-> plugin -> $DEST"
    rm -rf "$DEST"
    mkdir -p "$DEST"
    # Copy only what the runtime needs: the Python half + sidecar (with the
    # compiled bridge and the device registry) + docs
    for item in __init__.py runtime.py plugin.yaml dashboard sidecar docs scripts README.md LICENSE; do
      [ -e "$SRC/$item" ] && cp -R "$SRC/$item" "$DEST/"
    done
    find "$DEST" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
    chmod +x "$DEST/sidecar/bin/atvv-link" 2>/dev/null || true
  fi
fi

if [ "$WITH_DESKTOP" = "yes" ]; then
  if [ -f "$SRC/desktop/plugin.js" ]; then
    echo "-> desktop half -> $DESKTOP_DIR"
    mkdir -p "$DESKTOP_DIR"
    cp -R "$SRC/desktop/." "$DESKTOP_DIR/"
    # Deliberately make this copy byte-different from the packaged
    # desktop/plugin.js: on every launch Hermes runs
    # reconcileUnifiedDesktopHalves, and only when the two plugin.js files are
    # identical does it write .hermes-package.json and adopt the directory as
    # the "unified package desktop half". A package with that marker is opt-in
    # in runtime-loader (defaultEnabled=false), so no sidebar entry appears.
    # Without the marker it loads as a user-installed plugin.
    if ! grep -q '\[local copy\]' "$DESKTOP_DIR/plugin.js" 2>/dev/null; then
      cat >> "$DESKTOP_DIR/plugin.js" <<'MARK'

// [local copy] Deliberately byte-different from the packaged desktop/plugin.js:
// Hermes's reconcile only adopts this directory as the unified package's desktop
// half when it is identical to the packaged file (it then writes
// .hermes-package.json, so runtime-loader's defaultEnabled=false and the plugin
// must be enabled by hand once). Without the marker it loads as a desktop plugin
// the user installed: enabled by default, and not overwritten by package updates.
// Do not carry this block when syncing code back into the package.
MARK
    fi
  else
    echo "! no desktop/plugin.js in the repository, skipping the desktop half" >&2
  fi
fi

if [ "$DESKTOP_ONLY" = "yes" ]; then
  cat <<EOF

Desktop half refreshed: $DESKTOP_DIR/plugin.js
Restart the Hermes app and look for "Voice Remote" in the sidebar.
EOF
  exit 0
fi

cat <<EOF

Installed. Three steps left (all of them yours to run):

1) Enable the plugin:
   HERMES_HOME="$HERMES_HOME_DIR" hermes plugins enable $PLUGIN_ID

2) Speech models (pick one):
   node "$PLUGINS_DIR/$PLUGIN_ID/scripts/fetch-models.mjs"        # download SenseVoice int8 + VAD
   # or: enter an existing model directory / an external OpenAI-compatible STT service in the page

3) Restart the gateway once so the new routes mount (an app restart is not a gateway restart):
   hermes gateway restart

The desktop half (if installed) must be enabled once under Hermes Settings > Capabilities > Plugins
before the page appears in the sidebar.
EOF
