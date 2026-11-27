#!/bin/bash
# Five test suites, in order. Build first, then run:
#   1) harness           -- renderer key engine (stub SDK/react, drives events and actions)
#   2) model-precision   -- daemon-side model precision selection (pure logic)
#   3) hid-filter        -- key ownership (only the current device by default, 'any' for both)
#   4) devices-registry  -- device profile registry (merge/lookup/override/derive, plain Node)
#   5) profile-render    -- key table rendered for the current model (Xiaomi vs Chromecast)
# None of them needs Electron, the gateway or hardware.
#
# The suites run the *built* products (tests/*.mjs, generated from src/tests/*.mts by
# dev/build.mjs), never the installed copy. A failed build fails the run: no stale
# products are allowed to stand in for a broken one.
set -u

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root" || exit 1

if [ ! -d dev/node_modules ]; then
  echo "dev/node_modules missing, installing build dependencies..."
  ( cd dev && npm install --no-audit --no-fund ) || { echo "BUILD FAIL (npm install)"; echo "EXIT 1"; exit 1; }
fi

# The suites load the real desktop bundle, so `@hermes/plugin-sdk` and `react` have
# to resolve next to it. tests/support holds the stubs (tracked); copy them into
# tests/node_modules, which is ignored, so a fresh checkout can run the suites.
rm -rf tests/node_modules
cp -R tests/support tests/node_modules || { echo "BUILD FAIL (stubs)"; echo "EXIT 1"; exit 1; }

echo "== build =="
if ! node dev/build.mjs; then
  echo "BUILD FAIL"
  echo "EXIT 1"
  exit 1
fi

suites="harness model-precision hid-filter devices-registry profile-render"
total=0
passed=0
failed=0
failed_names=""

for name in $suites; do
  total=$((total + 1))
  file="tests/$name.mjs"
  echo "== $name ($file) =="
  if node "$file"; then
    passed=$((passed + 1))
  else
    failed=$((failed + 1))
    failed_names="$failed_names $name"
  fi
done

echo
if [ "$failed" -ne 0 ]; then
  echo "SUMMARY $passed/$total suites passed, $failed failed:$failed_names"
  echo "EXIT 1"
  exit 1
fi
echo "SUMMARY $passed/$total suites passed, 0 failed"
echo "EXIT 0"
exit 0
