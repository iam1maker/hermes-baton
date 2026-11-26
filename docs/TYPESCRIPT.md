# TypeScript 源码与构建

插件交付的是**可直接被 Hermes 加载的产物**（`sidecar/**/*.mjs`、`desktop/plugin.js`、
`scripts/*.mjs`、`tests/*.mjs`），而这些东西现在全部由 `src/` 下的 TypeScript 编译得到。
仓库里同时保留产物，是因为 Hermes 安装器只复制文件、不跑构建。

```
src/
├── sidecar/
│   ├── server.mts                  守护进程（HTTP API + 桥 + 转写调度）→ sidecar/server.mjs
│   ├── stt/sensevoice.mts          SenseVoice 识别器            → sidecar/stt/sensevoice.mjs
│   ├── devices/index.mts           型号注册表                   → sidecar/devices/index.mjs
│   └── vendor/                     从 DSH bundle 派生的 ATVV/音频/桥封装（.ts，产物 .js）
├── desktop/plugin.tsx              渲染层（React + JSX）        → desktop/plugin.js（单文件 bundle）
├── scripts/fetch-models.mts        模型下载                      → scripts/fetch-models.mjs
└── tests/*.mts                     5 个测试                      → tests/*.mjs
dev/                                构建与类型检查工具链（不随插件安装）
types/hermes-plugin-sdk.d.ts        SDK 的最小本地类型镜像
tsconfig.json                       strict + NodeNext + jsx: react-jsx
```

## 为什么扩展名是 `.mts`，而 vendor 是 `.ts`

输出文件名必须与运行时一致，`sidecar/server.mjs` 这种 `.mjs` 不能变成 `.js`（`runtime.py`
按名字 spawn，用户文档也按名字引用）。TypeScript 在 `NodeNext` 下把 `import './x.mjs'`
解析到 `x.mts` 源，所以：

- 需要以 `.mjs` 交付的源 → 写成 `.mts`（esbuild 默认把 `.mts` 输出成 `.mjs`）；
- vendored 的 ATVV/音频模块历史上就以 `.js` 交付（`import './vendor/ble/sidecar.js'`），
  所以它们的源是 `.ts`，产物 `.js`，说明符不用改；
- 渲染层是打包产物，扩展名无所谓，用 `.tsx` 才能写 JSX。

这条规则换来的是：**运行时文件名一个都没变**，`install.sh`、`runtime.py`、用户文档、
测试脚本里的路径全部保持原样。

## 构建与检查

```bash
cd dev && npm install --no-audit --no-fund   # 首次：typescript + esbuild + @types
node dev/typecheck.mjs                       # 整项目类型检查（等价 tsc --noEmit）
node dev/typecheck.mjs --files src/sidecar/server.mts   # 只查一个文件
node dev/build.mjs                           # 重新生成全部产物
bash tests/run.sh                            # 先 build 再跑 5 个测试
```

`dev/build.mjs` 的映射关系：

| 源 | 产物 | 方式 |
| --- | --- | --- |
| `src/sidecar/**` | `sidecar/**` | 逐文件编译，ESM，不打包（vendored 模块保持独立） |
| `src/scripts/**` | `scripts/**` | 同上 |
| `src/tests/**` | `tests/**` | 同上 |
| `src/desktop/plugin.tsx` | `desktop/plugin.js` | esbuild 打成单文件，`react` / `react/jsx-runtime` / `@hermes/plugin-sdk` 保持 external |

渲染层的硬约束（`apps/desktop/src/contrib/runtime-loader.ts`）：入口必须叫
`<id>/plugin.js`、单文件、≤512 KiB、只能 import 那三个包。`dev/build.mjs` 会在超过
512 KiB 时直接失败，并把 sha256 前缀打出来便于和已安装副本比对。

## 四个坑（都是踩过的）

1. **根目录不能放 `package.json`。** 安装器看到它会认为插件声明了 Node 依赖，弹出
   `npm ci` 提示。所以工具链的依赖装在 `dev/`（`dev/package.json` + `dev/node_modules`），
   `install.sh` 的白名单本来就不含 `dev/`。
2. **网关里不能直接跑 `tsc`。** gateway 的生命期守卫会拒绝扫描全局 `tsc` 脚本（>1 MiB），
   所以 `dev/typecheck.mjs` 用 TypeScript 的 compiler API 在自己进程里跑：
   `createRequire` 加载 `dev/node_modules/typescript`，诊断格式与 `tsc` 一致。
3. **esbuild 不会把 `.mts` 输出成 `.mjs`。** 不加 `outExtension` 时 `a.mts` → `a.js`，而所有
   说明符写的是 `.mjs`，于是静默解析到迁移前的旧文件 —— 测试全绿但测的是旧模块（实测踩到）。
   所以 `dev/build.mjs` 把 `.mts` 与 vendor 的 `.ts` 分成两次 build：`.mts` 带
   `outExtension: { '.js': '.mjs' }`，`.ts` 保持 `.js`（import 里就写着 `./vendor/…/session.js`）。
   顺带清掉同名的陈旧 `.js` 并打印 `removed stale …`。
4. **`install.sh` 的 `rm -rf` 会删掉源码。** 在 profile 里开发时源码目录就是安装目录
   （`~/.hermes/profiles/<p>/plugins/baton`），脚本原样执行会先删空再复制。现在脚本比对
   `pwd -P` 后跳过复制；只想刷桌面半用 `--desktop-only`。

## 改代码的流程

1. 改 `src/**`（不要直接改产物）；
2. `node dev/typecheck.mjs`；
3. `node dev/build.mjs`，产物顶部的 `// GENERATED — edit src/ …` 横幅说明它不该手改；
4. `bash tests/run.sh`；
5. 桌面半要用 `bash scripts/install.sh <profile> --with-desktop` 重装（脚本会给副本追加
   `[本机副本]` 横幅，让 Hermes 把它当用户自装插件而不是「统一包的桌面半」）。
