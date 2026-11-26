# 设计：Baton（原 baton）

一根指挥棒驱动整个乐团。插件把「物理遥控器」变成 Hermes 的输入与控制面：语音进输入框、按键触发动作。
名字刻意不绑定「语音」或「遥控」，因为它描述的是**一类输入设备**，以后接旋钮、脚踏板、MIDI 控制器都不需要改名。

---

## 1. 分五层，改动落在最外面那一层

```
┌─ 渲染层  desktop-plugins/baton/plugin.js     页面、按键引擎、输入框注入（无构建，纯 JS）
├─ 网关层  dashboard/plugin_api.py              /api/plugins/baton/*  ← 渲染层只跟它说话
├─ 进程层  runtime.py + __init__.py             拉起/守护 sidecar，注册 agent 工具 baton
├─ 服务层  sidecar/server.mjs                   事件流、按键引擎、STT、配置、HTTP 8791
├─ 适配层  sidecar/devices/*.json               ★ 型号在这里，不在代码里
└─ 传输层  sidecar/native/main.swift (atvv-link)  BLE ATVV 语音流 + IOHIDManager 旁听按键
```

**判断一条改动该落在哪层**：换了遥控器 → 适配层；换了识别模型 → 服务层（`sidecar/stt/`）；换了 UI → 渲染层；
新增一种「动作」（比如「打开某 App」）→ 服务层 + 渲染层的动作下拉。传输层只在协议变化时才动。

---

## 2. 适配层：型号是数据，不是代码

一台遥控器 = `sidecar/devices/<id>.json`。代码里没有任何 `if (型号 === '小米')`。

| 字段 | 作用 | 谁读它 |
|---|---|---|
| `id` | 稳定标识，配置与事件里都用它 | 全部 |
| `label` / `vendor` | 页面展示 | 渲染层 |
| `match.vendorIds` / `productIds` | HID 设备匹配（十进制 VID/PID） | 桥（间接）、匹配逻辑 |
| `match.nameHints` | 桥上报的 `device` 名 → 型号（双向包含匹配，容忍昵称） | `profileForDeviceName()` |
| `hidPairs` | 旁听白名单，原样传给桥 `--hid-device` | `bridgeArgs` |
| `pages` | 该型号会上报的 usage page | 桥 `--hid-pages` |
| `keys` | `page/usage` → `KeyboardEvent.code`，**只写这台特有的键** | `codeFor()` |
| `hidKeys` | 允许进入事件流的 code 白名单（漏一个就是这个键完全没反应） | 服务层 |
| `defaultKeyMap` | 该型号的默认动作；用户 `settings.json` 里的 keyMap 永远压过它 | 服务层 |
| `voiceHint` / `notes` | 页面提示与已知限制 | 渲染层 |

`_base.json` 放 HID Usage Tables 的标准键（键盘页 0x07、Consumer 页 0x0C 的音量与 Back），所有型号共享。
合并顺序：`_base` → 内置型号 → 用户型号（`<state dir>/devices/*.json`，同名 `id` 覆盖）。

### 新增一台遥控器的成本

1. `hidutil list` 拿 VID/PID，`atvv-link --hid --list 4` 确认能连；
2. 抄一份 JSON，填 `keys`（未定名的键从 `daemon.log` 的 `[hid] unmapped page=… usage=…` 里读，配合厂商 keylayout 或 HID Usage Tables 定名）；
3. `POST /devices/reload` —— 注册表重读、桥参数重算、连接重启，**不重启守护进程、不重启 Hermes**。

这就是「热插拔」：型号是运行时可加载的数据。桥的页放行与设备白名单同样来自注册表（`--hid-pages` / `--hid-device`），
所以新遥控器不需要重新编译 Swift。

---

## 3. 页面联动：框 1 决定框 2

「遥控器」卡里选中的设备决定 `/state.profileId`，「按键映射」卡只渲染**该型号的键**（`profiles[i].keys`），
再并上用户手动加过的键（型号不支持的标「未知」，不隐藏）。切设备后两者同时变。

同一份 `keyMap` 是全局的：动作语义一致（`Back → 停止生成`），型号决定「哪些键存在」。
好处是切回小米时不需要重新配置；坏处是两台都有的键（Back）改一次等于两台都改 —— 这是刻意的，
因为用户的心智是「Back 就该停生成」，不是「小米的 Back」。

---

## 4. 依赖：模型与运行时不在仓库里

| 依赖 | 策略 |
|---|---|
| 语音模型（SenseVoice int8 ~250MB / fp32 ~900MB、Silero VAD） | 不进 git。三档：① `scripts/fetch-models.mjs` 下载（支持 Range 续传、sha256、`--from` 离线导入）；② 页面填本地路径；③ 外部 OpenAI 兼容 STT（`sttBaseUrl`/`sttModel`/`sttApiKey`），完全不用本地模型 |
| `sherpa-onnx-node`（原生 .node） | sidecar 的 npm 依赖，按平台安装；解析顺序 `REMOTE_MIC_SHERPA` → sidecar/node_modules → 宿主路径 |
| Node 运行时 | 用宿主的 node（`~/.hermes/tools/node-*`），不打包 |
| 蓝牙桥二进制 | 仓库里带编译好的 universal 二进制，源码同仓库（`build.sh` 可重建） |

判据：页面「识别」卡显示模型状态（路径 / 体积 / 是否加载），缺失时给下载命令而不是静默失败。

---

## 5. 权限与边界

- **蓝牙（TCC）**：连接遥控器（ATVV 推流）与旁听 HID 都需要，首次由系统弹窗授权，`IOHIDManager` 只读不拦。
- **键盘**：声音与按键都不写系统输入法，文字只进 Hermes 的输入框；「捕获键盘按键」默认关，开了才接管物理键盘的 Enter/Home。
- **音量键拦不住**：遥控器是系统级 HID，音量 ±/静音由 `AppleUserHIDEventService` 在系统层消费；插件只旁听。
  Power / Netflix / YouTube 同理（锁屏、拉起播放器），所以这三个默认只识别不动作。
- **按键归属**：默认只有「当前生效的那台」的按键产生动作（语音键本来就只走连上的那台），另一台的按键记一条日志后丢弃。
  可切成「两台都认」。
- **音频不出本机**：识别全本地；日志不含音频内容与蓝牙地址。

---

## 6. 已知取舍

- `keyMap` 不做「按型号分表」，理由见 §3。真要分表，加一层 `keyMapByProfile` 即可，不破坏现有配置。
- 桥的 HID 旁听是**进程级**的：只要守护进程活着，两台遥控器的 HID 事件都会进来，过滤在服务层做（因为设备名只有桥知道）。
- 网关新增路由不热重扫：`/devices`、`/devices/reload`、`/capture` 这类后加的路由要重启一次网关（应用重启≠网关重启）。
  服务层同时提供 8791 直连与 `/state` 里缓存字段做降级，页面不会因此白屏。
