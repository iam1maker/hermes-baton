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
