# 提交信息约定

和 [iam1maker/hermes-bark](https://github.com/iam1maker/hermes-bark) 保持同一套写法——就是那个仓库
GitHub 提交列表里看到的样子。下面是可执行的规则，不是风格偏好。

## 形状

```
type(scope): imperative lowercase sentence

为什么（问题是什么、哪条实测把根因钉死的）
怎么改的、改了哪几处
- 需要时用列表

Tests: bash tests/run.sh → 72 PASS（可验证行为才写这一行）
```

- **type** 只能是 `feat` / `fix` / `refactor` / `perf` / `docs` / `test` / `build` / `ci` /
  `chore` / `revert`。不要自造组合类型：`state:`、`docs+install:`、`rename:` 都不合法。
- **scope** 可选、单数小写，用这一层真正改动的地方：`baton`、`sidecar`、`desktop`、
  `dashboard`、`install`、`docs`、`ts`。`fix(gateway)` 只在网关代码真的改了时才用；
  插件自己的 manifest 写错名字属于 `fix(dashboard)`。
- **标题行**：祈使句、全小写、无 emoji、无句号、≤ 72 列。说清「改了什么」，
  一个逗号并列两件事就是两条提交。
- **正文**：空行后开始，78 列换行。先写为什么（含实测证据），再写改了哪几处。
- **一条提交一件事**：代码和文档不要混在同一条里；同一条里应当能用一句话讲完。

## 判断标准

一条提交读起来应该像：

- `feat(bark): send-only Bark iOS push platform with desktop settings page`
- `fix: report the credential source the same way secret() resolves it`
- `refactor(settings): read credentials through agent.secret_scope.get_secret`
- `fix(install): keep the desktop copy marker-less so the pane shows on boot`

而不是：

- `rename to baton, BATON_* env vars with REMOTE_MIC_* fallback, docs for one-line install`
  （三个关注点挤在一行、没有 type）
- `state: keys.map shows only…`（`state` 不是我编的合法 type）

## 产物与源码同条提交

`src/` 是源码，`sidecar/**/*.mjs`、`desktop/plugin.js`、`scripts/*.mjs`、`tests/*.mjs` 是构建产物
（见 [docs/TYPESCRIPT.md](docs/TYPESCRIPT.md)）。改完源要 `node dev/build.mjs`，**产物必须和源码
一起提交**——否则装到 profile 里的还是旧代码。提交前自查：

```bash
node dev/typecheck.mjs && node dev/build.mjs && bash tests/run.sh
git status --porcelain          # 不该再出现「产物已改但没提交」
```
