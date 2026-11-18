# 0002 插件目录只扫当前 profile

## 状态

已采纳。

## 背景

面板把 `dsh-tool-antigravity` 与 `dsh-language-guard` 列了出来，但这两个包在**当前** profile（`web`）里根本不存在：`package.json` 的 `dependencies` 没有、`node_modules` 没有、`.pnpm` 也没有。它们只装在 `desktop` profile 里。

根因在 `catalog.ts` 的 `profileDirs()`：它优先读 `$DSH_PROFILE_DIR`，读不到就退回扫 `$DSH_HOME/profiles/*` **全部** profile。而 `$DSH_PROFILE_DIR` 只由 `dsh-shell-env` 注入给 bash 子进程，插件进程里是 `undefined`——退回分支是常态，不是例外。

于是面板显示的是「这台机器上所有 profile 装过的插件」，不是「当前 profile 装了的插件」。用户在 web 里卸载一个包，只要 desktop 还装着，它就继续出现在 web 的面板里，且开关对它无效（当前 profile 没有这个包，关不掉任何东西）。

## 决定

插件目录只扫**当前 profile**，来源是宿主的 `profileContext.dir`。

`profileContext` 是 `@deepseek-ai/dsh-app-boot` 提供的可选服务，字段 `dir` 就是当前 profile 的目录。它「只在由 dsh 启动的 profile 里存在」，因此：

- 拿得到：只扫 `profileContext.dir`。
- 拿不到（测试、非 profile 启动）：退回扫全部 profile，但目录标记 `complete: false`，并在 `warnings` 里写明「无法确定当前 profile，归属可能来自其他 profile」。

不选「拿不到就返回空目录」：那会让测试环境与异常启动下的面板完全不可用，而归属只是展示信息，不该把面板变成错误页。

## 后果

- **跨 profile 串味消失**。面板列出的包名，就是当前 profile 真正装了的那些。
- **「残留键」成为唯一需要清理的东西**。修复前，用户看到的「卸载了还在」有两种成因：跨 profile 串味（本 ADR 修的）与策略里的残留键（策略文件里有、当前名册里没有）。修复后只剩后者。
- **`complete: false` 的语义扩宽**：它原先只表示「扫描被预算或 IO 掐断」，现在还表示「不知道当前 profile 是哪个」。两者都让 `effective` 把 `open` 置 `null`，面板显示「未生效」——这是同一条纪律：不确定就不要假装确定。
- **`MAX_FILE_BYTES` 的跳过不再拖垮整包**。`dsh-experimental-inspector` 的 `lighthouse_worker.js` 是 9.2 MB 的产物文件，超过 8 MB 上限被跳过，原先把整包判成 `truncated`，进而让整个目录 `complete: false`、面板全部「未生效」、每次打开都触发重扫。改为：超限文件只把该包的 `toolsKnown` 置 `false`，不影响目录级的 `complete`。影响面从整个面板收窄到一行。
- **残留键的清理按包粒度**。一个包名一行，一次删掉它在所有 pack 里的项级键、组级键与分组归属；批量清理走现有的待保存改动 + 确认条，可试算。
- **三包共用「残留键」这个概念**，判定逻辑（策略里有、名册里没有）同构，因此定义进根术语表，实现各自提供「当前名册」。

## 考虑过的替代方案

**继续扫全部 profile，但在面板上标注来源 profile。** 保留信息量，但面板的开关只对当前 profile 生效——列出别的 profile 的包，等于给用户一个按下去没反应的按钮。信息量换不来决策价值。

**用 `$DSH_PROFILE_DIR` 环境变量。** 它在插件进程里不存在（只注入给 bash 子进程）。可以自己从 `process.argv` 或 `profileContext` 反推，但后者已经是权威来源，反推只会多一条会漂移的规则。

**拿不到 `profileContext` 时返回空目录。** 见上：把展示信息的缺失升级成面板不可用，代价与收益不成比例。

## 参考

- [ADR-0001](./0001-disable-by-plugin.md)：按插件停用的语义，本 ADR 不改变它。
- [ADR-0007](../../../docs/adr/0007-shared-core-package.md)：共享核心的边界；「残留键」的判定逻辑进 core，名册来源留在各包。
- `GLOSSARY.md`：残留键、能力项、生效视图。
