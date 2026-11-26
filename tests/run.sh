#!/bin/bash
# 五段测试：
#   1) harness.mjs —— 渲染层引擎（stub SDK/react，驱动事件流与按键动作）
#   2) model-precision.mjs —— 守护进程侧的模型精度选择纯逻辑
#   3) hid-filter.mjs —— 按键归属（默认两台都认，'active' 才只认当前设备）
#   4) devices-registry.mjs —— 设备型号注册表（合并/查表/覆盖/派生，纯 Node）
#   5) profile-render.mjs —— 按键映射表按当前生效型号渲染（小米/Chromecast 键表互斥）
# 都不需要 Electron、网关或硬件。
set -eu
cd "$(dirname "$0")"
node harness.mjs
node model-precision.mjs
node hid-filter.mjs
node devices-registry.mjs
node profile-render.mjs
