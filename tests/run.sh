#!/bin/bash
# 五段测试（先构建，再跑）：
#   1) harness           —— 渲染层引擎（stub SDK/react，驱动事件流与按键动作）
#   2) model-precision   —— 守护进程侧的模型精度选择纯逻辑
#   3) hid-filter        —— 按键归属（默认只认当前设备，'any' 才两台都认）
#   4) devices-registry  —— 设备型号注册表（合并/查表/覆盖/派生，纯 Node）
#   5) profile-render    —— 按键映射表按当前生效型号渲染（小米/Chromecast 键表互斥）
# 都不需要 Electron、网关或硬件。
#
# 测试跑的是**仓库构建产物**（tests/*.mjs 或 *.js，由 dev/build.mjs 从 src/tests/*.mts
# 生成），不是已安装副本。构建失败即整体失败，不会拿旧产物充数。
set -u

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root" || exit 1

if [ ! -d dev/node_modules ]; then
  echo "dev/node_modules 缺失，先安装构建依赖…"
  ( cd dev && npm install --no-audit --no-fund ) || { echo "BUILD FAIL (npm install)"; echo "EXIT 1"; exit 1; }
fi

echo "== build =="
if ! node dev/build.mjs; then
  echo "BUILD FAIL"
  echo "EXIT 1"
  exit 1
fi

# 产物扩展名取决于 dev/build.mjs 的 outExtension：esbuild 默认把 .mts 编成 .js，
# 若构建侧把它改成 .mjs（与 import 说明符一致）就用 .mjs。取两者中较新的那个，
# 避免拿上一次构建残留的旧文件。
pick_test() {
  local name="$1"
  local mjs="tests/$name.mjs"
  local js="tests/$name.js"
  if [ -f "$mjs" ] && { [ ! -f "$js" ] || [ "$mjs" -nt "$js" ]; }; then
    printf '%s' "$mjs"
  elif [ -f "$js" ]; then
    printf '%s' "$js"
  else
    printf '%s' "$mjs"
  fi
}

suites="harness model-precision hid-filter devices-registry profile-render"
total=0
passed=0
failed=0
failed_names=""

for name in $suites; do
  total=$((total + 1))
  file="$(pick_test "$name")"
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
