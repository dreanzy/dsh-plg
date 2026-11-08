# @dreanzy/dsh-skill-pack

按工作区控制 skill 可见性的 DSH 插件。工作区只绑一个 pack，pack 是一张具名的开关表；未绑定按 `default` 求值。

[English](README.en.md) | **简体中文**

## 它解决什么问题

装得多之后，每一轮请求都要重新付一遍清单成本：skill 目录进上下文、候选太多让模型选错、A 项目的专用能力在 B 项目里一直占位。

本插件把「模型此刻能自动调用哪些 skill」变成一组开关，并让工作区只做一次选择：

```
工作区绑定的 pack  ??  default pack  ??  默认开
```

`??` 表示「前一环有记录就不读后面的」。pack 里只存**显式决定**：键不存在就是跟随，`false` 是有效取值，不是跟随。

同一批工作区（比如五个美术项目）共用一张 pack，改一次全部生效。

## 分组

分组只说明「哪些项是一类」，本身不是开关：

- 一个 skill 最多属于一个分组，未归属的就是未分组。
- pack 可以按分组设开关，组内后加入的成员自动跟随这条决定。
- 组定义跨工作区共享，改组名不影响任何 pack 里的组级决定。

## 安装

需要 DSH `0.2.x`（`0.2.0-rc.2` 及以上）。

**在 Web 界面安装**：设置 → 插件 → 添加插件 → 安装第三方插件，输入包名：

```
@dreanzy/dsh-skill-pack
```

**命令行安装**：

```sh
dsh plugin --profile <profile> add @dreanzy/dsh-skill-pack
```

装完重启 Host、刷新页面。两个入口：输入框右侧的 chip，和 设置 → Skill Pack。chip 的显示可以在设置里关掉。

从源码安装（需要 pnpm 允许该包执行构建）：

```sh
dsh plugin --profile <profile> add "github:dreanzy/dsh-plg#<sha>&path:/packages/dsh-skill-pack"
```

## 编辑与保存

分包页与工作区页的每次改动即时写入，没有草稿；分组的新建、改名、删除与归属调整同样是即时写入。

> 早期版本侧栏面板有「保存 / 撤销」草稿，随侧栏入口一并移除。见 [docs/adr/0005-draft-and-save.md](docs/adr/0005-draft-and-save.md)（已不适用）。

## 界面

- 设置 → Skill Pack 分三页：`分组` / `分包` / `工作区`。
- 「分组」按组折叠展示成员，展开后在行内改归属；搜索同时匹配技能名与分组名。
- 「分包」编辑 pack 名册与包内开关。选中「默认」时开关只有开与关——它是求值链的终点，没有上一层。
- 「工作区」列出开过会话的目录与手动添加的路径，每行一个 pack 下拉。

## 文件

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/packs/skill/packs.json` | pack 名册：每张 pack 的项级与组级决定，加上界面开关（是否显示 chip、默认分页） |
| `$DSH_HOME/packs/skill/groups.json` | 分组定义与成员归属，跨工作区共享 |
| `$DSH_HOME/packs/skill/workspaces.json` | 工作区 → pack 的绑定，以及手动添加的路径 |

工作区目录不再产生任何文件：绑定表放在全局，工程目录保持干净。

## 写入语义

每一次开关提交的是一组**意图**（`{键, 值|null}`），服务端在文件锁内读—改—写，不比对任何版本。命令幂等、可交换，写同一键即后点者赢，因此不存在 `stale-revision` 这类冲突。`null` 表示删掉这条键、回到跟随——写一个同值不等于跟随。

详见 [docs/adr/0001-intent-writes.md](docs/adr/0001-intent-writes.md)。

## 已知边界

- **只管 skill**。MCP 的按工作区开关不在本包范围（MCP 一侧在 DSH 里没有干净的收窄点）。见 [docs/adr/0004-skill-only-scope.md](docs/adr/0004-skill-only-scope.md)。
- 会话中途切换工作目录不会重算策略，重开会话即恢复。
- 同层 first-wins：若别的插件先把同名 skill 注册进同一层，那条关不掉，面板会在该行标出「关不掉」。
- 官方 `@deepseek-ai` 技能默认不在面板出现（判定见 `src/inventory.ts`），但模型仍可调用；打开「显示官方技能」后可逐项关闭。

## 与 dsh-skill-scope 的关系

两者都往 Agent 同层注册遮蔽副本，**不能共存**，装本插件前请卸载它。本插件不读它的配置，迁移需要手动重配。