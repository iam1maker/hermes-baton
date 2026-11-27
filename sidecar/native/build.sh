#!/usr/bin/env bash
# Build the CoreBluetooth bridge (universal binary + ad-hoc signature).
# Needs only swiftc from the Xcode Command Line Tools; overwrites sidecar/bin/atvv-link.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIDECAR="$(cd "$HERE/.." && pwd)"
OUT="$SIDECAR/bin/atvv-link"

ARCHES=(arm64 x86_64)
if [[ "${1:-}" == "--native" ]]; then
  ARCHES=("$(uname -m)")
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SLICES=()
for arch in "${ARCHES[@]}"; do
  echo "compiling ${arch}..."
  swiftc -O -swift-version 5 -target "$arch-apple-macosx13.0" \
    -o "$TMP/atvv-link-$arch" "$HERE/main.swift"
  SLICES+=("$TMP/atvv-link-$arch")
done

if [[ ${#SLICES[@]} -eq 1 ]]; then
  cp "${SLICES[0]}" "$OUT"
else
  lipo -create "${SLICES[@]}" -output "$OUT"
fi
chmod +x "$OUT"
codesign --force --sign - "$OUT" >/dev/null 2>&1 || echo "warning: ad-hoc codesign failed (bridge still usable)"
echo "built $OUT ($(lipo -archs "$OUT" 2>/dev/null || uname -m))"
