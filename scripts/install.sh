#!/usr/bin/env bash
# Baton 安装脚本：把本仓库装成某个 Hermes profile 的插件，并可选装桌面半。
#
#   bash scripts/install.sh                 # 装到 default profile
#   bash scripts/install.sh forge           # 装到 forge profile
#   bash scripts/install.sh forge --with-desktop
#
# 只做三件事：复制插件目录、复制桌面插件（可选）、打印下一步要你手动跑的 enable 命令。
# 不碰 config.yaml、不碰 .env、不写任何密钥。
set -euo pipefail

PROFILE="${1:-default}"
WITH_DESKTOP="no"
for arg in "$@"; do
  case "$arg" in
    --with-desktop) WITH_DESKTOP="yes" ;;
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
  echo "找不到 profile 目录：$HERMES_HOME_DIR" >&2
  echo "先运行一次 Hermes，或检查 profile 名（ls ~/.hermes/profiles）" >&2
  exit 1
fi

PLUGINS_DIR="$HERMES_HOME_DIR/plugins"
DESKTOP_DIR="$HOME/.hermes/desktop-plugins/$PLUGIN_ID"
mkdir -p "$PLUGINS_DIR"

echo "→ 插件 → $PLUGINS_DIR/$PLUGIN_ID"
rm -rf "$PLUGINS_DIR/$PLUGIN_ID"
mkdir -p "$PLUGINS_DIR/$PLUGIN_ID"
# 只复制运行必需的东西：Python 半 + sidecar（含已编译的桥与型号注册表）+ 文档
for item in __init__.py runtime.py plugin.yaml dashboard sidecar docs scripts README.md LICENSE; do
  [ -e "$SRC/$item" ] && cp -R "$SRC/$item" "$PLUGINS_DIR/$PLUGIN_ID/"
done
find "$PLUGINS_DIR/$PLUGIN_ID" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
chmod +x "$PLUGINS_DIR/$PLUGIN_ID/sidecar/bin/atvv-link" 2>/dev/null || true

if [ "$WITH_DESKTOP" = "yes" ]; then
  if [ -f "$SRC/desktop/plugin.js" ]; then
    echo "→ 桌面半 → $DESKTOP_DIR"
    mkdir -p "$DESKTOP_DIR"
    cp -R "$SRC/desktop/." "$DESKTOP_DIR/"
    # 刻意让这份副本与插件包内的 desktop/plugin.js 字节不同：Hermes 每次启动都会跑
    # reconcileUnifiedDesktopHalves，只有当两处 plugin.js 完全相同才写 .hermes-package.json
    # 把目录收编为「统一包的桌面半」，而带 marker 的包在 runtime-loader 里是 opt-in
    # （defaultEnabled=false），侧栏不会出现入口。保持 marker-less 时它按用户自装插件加载。
    if ! grep -q '\[本机副本\]' "$DESKTOP_DIR/plugin.js" 2>/dev/null; then
      cat >> "$DESKTOP_DIR/plugin.js" <<'MARK'

// [本机副本] 刻意与插件包内 desktop/plugin.js 保持字节不同 —— Hermes 的 reconcile 只有在
// 「与包内源文件完全相同」时才把该目录收编为统一包的 desktop 半（写 .hermes-package.json，
// 于是 runtime-loader 的 defaultEnabled=false，必须手动启用一次）。保持 marker-less 时它按
// 「用户自己放的桌面插件」加载：默认启用，也不会被包更新覆盖。同步包内代码时别带上这一段。
MARK
    fi
  else
    echo "! 仓库里没有 desktop/plugin.js，跳过桌面半" >&2
  fi
fi

cat <<EOF

装好了。还差三步（都需要你自己执行）：

1) 启用插件：
   HERMES_HOME="$HERMES_HOME_DIR" hermes plugins enable $PLUGIN_ID

2) 语音模型（二选一）：
   node "$PLUGINS_DIR/$PLUGIN_ID/scripts/fetch-models.mjs"        # 下载 SenseVoice int8 + VAD
   # 或：在页面「识别」卡里填已有模型目录 / 填外部 STT 服务（OpenAI 兼容）

3) 重启一次网关，让新路由挂上（应用重启不等于网关重启）：
   hermes gateway restart

桌面半（若装了）需要在 Hermes 设置 ▸ 能力 ▸ 插件里打开一次开关，页面才会出现在侧栏。
EOF
