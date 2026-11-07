# @dreanzy/dsh-model-pack

按工作区为新建会话指定模型与子智能体档位。

## 它做什么

把「哪个工作区用哪个模型、子智能体各档怎么路由」组合成一个可命名的 **pack**，绑定到工作区。只作用于该目录下**之后新建**的会话，已有会话不受影响。两件事：

1. 会话使用的 provider / model / reasoningEffort；
2. 子智能体（`subagent_tier` 工具）四档难度各自的路由，含首选与备选。

会为空白会话把 `default` pack 的会话路由同步成进程级默认显示（不改写任何已有会话的选择），不接管官方 composer 模型选择器的交互，不管智能体团队（`spawn_teammate`）的成员路由。

## pack 与求值

```
工作区绑定的 pack  →  packs.default  →  出厂内置
```

前一环存在就不读后面的。工作区只存一个绑定：绑到某个 pack，或什么都不绑（走 `default`）。`default` 是内置 pack，不可删除、不可改名，内容可编辑——它就是原来「全局默认方案」的落点。绑定悬空（指向已删 pack）时读侧按 `default` 求值，并在面板标出来。

`prompts.json` 与 pack 正交：所有 pack 共用同一份提示词覆盖，全局一份，不随绑定变化。

工作区目录下不再产生任何状态文件。

## 状态

功能完整：三级求值链、`subagent_tier` 工具、委派提示词段、设置页与模型位 pack 名都已实现。宿主缺少子智能体服务或 `tools.restrict` 时按 spec §6.4 降级，面板显示原因。

## 文件

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/packs/model/packs.json` | pack 名册与 `ui` 段（`showChip`、`defaultTab`） |
| `$DSH_HOME/packs/model/prompts.json` | 提示词覆盖，与 pack 正交 |
| `$DSH_HOME/packs/model/workspaces.json` | 工作区 → pack 的绑定表，外加手动添加的路径 |

三个文件各自独立事务：pack 的编辑压力都在 `packs.json`，提示词与绑定变动稀少，拆开是为了让每份文件都能单独原子写。删除一个 pack 后，绑定表里指向它的键会成为悬空引用，读侧按 `default` 求值，写侧顺手清掉。

旧路径（`$DSH_HOME/model-scheme/` 与 `<cwd>/.dsh/model-scheme.json`）仍被**兼容读**：新文件不存在时在内存里映射成 pack 与绑定，读取路径绝不写盘。迁移由独立脚本完成。

```jsonc
// $DSH_HOME/packs/model/packs.json
{
  "version": 1,
  "ui": { "showChip": true, "defaultTab": "model" },
  "packs": {
    "default": { "name": "出厂方案", "tiers": {} },
    "p1": {
      "name": "标准",
      "session": { "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": "high" },
      "tiers": {
        "tier1": {
          "name": "侦察",
          "primary": { "provider": "deepseek", "model": "deepseek-chat" },
          "fallbacks": []
        }
      }
    }
  }
}
```

## 面板

设置页三页：**模型 | 提示词 | 分包**。`ui.defaultTab` 只决定打开时落在哪一页；切换分页不写盘，只有顶部那组单选才改默认页。`分包` 页可新增、改名、删除 pack，并编辑选中 pack 的会话路由与四档；`default` 的删除与改名入口不存在。`ui.showChip === false` 时 composer 里的 chip 不注册。

写命令见 `api/model-pack/apply`：`createPack` / `renamePack` / `deletePack` / `bind` / `addExtra` / `removeExtra` / `showChip` / `defaultTab`，外加本包的内容编辑命令 `putPack` / `packSession` / `packTier`。

## 安装

```sh
dsh plugin --profile <profile> add ./packages/dsh-model-pack
```

装完重启宿主。未绑定工作区时用 `default`，未配置 `default` 时插件不改变任何行为。
