# Pack 重构：用 pack 取代工作区级逐项开关

## 背景

四个插件（skill / plugin / mcp / model）目前各自维护两层策略：全局层落在 `$DSH_HOME/<包名>/`，工作区层落在 `<cwd>/.dsh/<包名>.json`。用户要为每个工作区逐项决定 skill、插件、MCP 行的开关，工作区一多，同一批决定要在多个目录里重复维护。

`dsh-model-scheme` 已经证明另一条路可行：它把「一套命名配置」放在全局，工作区只存一个 `{ schemeId }` 的绑定。本重构把这条思路推广到全部四个领域，并把 `scheme` 统一改称 `pack`。

## 目标

1. 每个领域引入 pack：一张由能力项/分组开关组成的具名策略表。工作区只绑一个 pack，不再持有任何逐项决定。
2. 四个插件的配置全部收进 `$DSH_HOME/packs/<领域>/`，工作区目录下不再产生任何状态文件。
3. 设置页按领域分页（skill / plugin / mcp 三页：`分组 | 分包 | 工作区`）；新会话 chip 降级为 pack 绑定入口，并可整体关闭。
4. 包名统一为 `dsh-<领域>-pack`。

## 不做

- 不合并四个包，不引入共享包。ADR 0002 的「零共享」继续有效：四个领域各有一套 pack 名册，互不可见。
- 不做跨领域 pack（一个 pack 同时管 skill 与 MCP）。
- 不做工作区绑定多个 pack。一个工作区恰好一个 pack，未绑定即走 `default`。
- 不做 pack 继承、pack 嵌套、pack 导入导出。

## 术语

**Pack（分包）**：
一张具名的策略表，只含覆盖决定，不含成员清单。意图是把「改一个工作区的可见性」从逐项操作降级为一次选择。

**Default pack**：
内置、不可删除、不可改名的一个 pack，承接原来全局层的角色。工作区未绑定时用它。

**Group（分组）**：
与 pack 正交：分组描述「哪些项是一类」，pack 描述「这些项对这些工作区是开是关」。一个能力项最多属于一个分组。MCP 目前没有分组，本次补上。

**Item（能力项）**：
可开关单元。skill 用名字，插件用包名，MCP 用行键，model 领域没有 item。

**求值链（Resolution chain）**：
工作区绑定的 pack → default pack → 内置缺省。层级之间不再有「工作区层压全局层」的规则，因为工作区层已经不存在。

## 通用设计

### pack 的形状

```ts
interface Pack {
  readonly name: string
  readonly items: Readonly<Record<string, boolean>>
  readonly groups: Readonly<Record<string, boolean>>
}
```

`items` 与 `groups` 的键不存在即跟随上一层；`false` 是有效取值，不是「跟随」。这与现有 `LayerPolicy` 的语义完全一致，因此旧的工作区层数据可以原样搬进一个 pack。

model 领域的 pack 形状不同（见下文），它没有 item 与 group。

### 求值链

skill 与 plugin（逐布尔）：

```
pack.items[项] ?? pack.groups[组] ?? default.items[项] ?? default.groups[组] ?? true
```

MCP（逐字段）：与现在同构，只是把 `workspace` 换成 `pack`、`global` 换成 `default`。

`true` 是缺省值：未记录即可见。这条不变。

### 落盘

```
$DSH_HOME/packs/
├── skill/
│   ├── packs.json        # { version, ui, packs: { default: {...}, [id]: {...} } }
│   ├── groups.json       # { version, groups: [{id,name}], assignments: { 项名: 组id } }
│   └── workspaces.json   # { version, bindings: { cwd键: packId }, extra: [路径] }
├── plugin/               # 同上三件
├── mcp/                  # 同上三件
└── model/
    ├── packs.json        # { version, ui, packs: { default: { name, session?, tiers } } }
    ├── prompts.json      # 提示词覆盖，与 pack 正交，沿用现文件内容
    └── workspaces.json
```

分开成三个文件，不为每个 pack 单开文件。理由是现有的 `transact` 是单文件读-改-写，跨文件写必然引入两阶段提交；`packs.json` 承担全部编辑压力，`groups.json` 与 `workspaces.json` 变动稀少，三者各自原子。删除 pack 时 `workspaces.json` 里指向它的绑定成为悬空引用，读侧忽略它，与现有「孤儿决定」的处理方式一致。

`ui` 段：

```json
{
  "showOfficialSkills": false,
  "showChip": true,
  "defaultTab": "groups"
}
```

`showChip` 与 `defaultTab` 是本次新增。`defaultTab` 取 `"groups" | "packs" | "workspace"`，**只**决定设置页打开时落在哪一页：切换分页不写它，只有设置页顶部那组「打开设置时默认显示」的单选才改它。

`showSidebarEntry` 已随侧栏入口一起废弃（skill 的侧栏面板与 `sidebar.panellist` / `main` 注册一并删除）。旧文件里残留这个键时忽略，不报错。

### 工作区键

绑定表的键是规范化后的 cwd：反斜杠转正斜杠、剥除尾部斜杠、Windows 下转小写；盘符根目录保留尾斜杠（`c:/`）。`dsh-skill-manager` 与 `dsh-mcp-manager` 已有 `normalizeCwd`，`dsh-plugin-manager` 没有，本次统一，三处必须逐字节一致。

`dsh-model-scheme` 目前用原始 cwd 作键，迁移时一并规范化。

### 工作区清单

不扫描磁盘，不自建目录清单。列表来自宿主会话：`ctx.remote.session.list()` 返回的会话项含 `cwd`，排除 `origin === 'subagent'`，按 `updatedAt` 倒序去重。当前会话所在目录置顶。

`workspaces.json` 的 `extra` 数组只存用户手动添加的路径，用于覆盖「从未开过会话的目录」。

### default pack

`packs.json` 的 `packs.default` 是内置项，UI 不提供删除与改名入口，但内容可编辑。它是工作区未绑定时的取值来源，也是原来 `global.json` 的迁移落点。

## 四个领域

### skill（dsh-skill-pack）

- item 键：skill 名。
- pack：`{ name, items, groups }`。
- 分组：沿用现有 `groups.json` 形状。
- 删除：`<cwd>/.dsh/skill-manager.json`、`$DSH_HOME/skill-manager/`。

### plugin（dsh-plugin-pack）

与 skill 同构，item 键换成插件包名。原有 `catalog.json`（归属扫描缓存）继续留在 `$DSH_HOME/packs/plugin/catalog.json`，它不属于策略，只是缓存。

### mcp（dsh-mcp-pack）

- **补分组**：新增 `groups.json`，`assignments` 以行键（`own:<name>` / `global:<name>`）为键。这是本次唯一的**新增**数据结构。
- pack 逐字段求值，但组级只给一个布尔开关：

```ts
interface McpPack {
  readonly name: string
  readonly groups: Readonly<Record<string, boolean>>      // 组级只决定开/关
  readonly rows: Readonly<Record<string, RowPolicy>>      // 行级可设 enabled/mode/tools/description
}
```

  这是取舍：组级若也能设四个字段，立刻会遇到「组说 `dynamic`、行说 `disabled`」的合并规则，而那条规则没有廉价答案。组级只做开合，逐字段只留在行级。

- 删除：`<cwd>/.dsh/mcp-manager.json`、`$DSH_HOME/mcp-manager/`；`servers.json`（托管连接定义）迁到 `$DSH_HOME/packs/mcp/servers.json`，它不属于策略，只是连接配置。

### model（dsh-model-pack）

- 没有 item 与 group，pack 就是现在的 `Scheme`：`{ name, session?, tiers }`。
- `packs.json` 的 `packs.default` 对应原来的出厂方案，但这次它**可编辑**。原 `defaultSchemeId` 语义由「工作区未绑定即用 default」取代。
- `prompts.json` 保留，与 pack 正交，全局一份。
- 设置页只加「分包」页，不加「分组」页：没有可分组对象。页签变成「模型 | 提示词 | 分包」。

## 路由

所有路由仍是 `POST`，前缀随包名改：

| 领域 | 旧前缀 | 新前缀 |
|---|---|---|
| skill | `/api/skill-manager/` | `/api/skill-pack/` |
| plugin | `/api/plugin-manager/` | `/api/plugin-pack/` |
| mcp | `/api/mcp-manager/` | `/api/mcp-pack/` |
| model | `/api/model-scheme/` | `/api/model-pack/` |

每个领域三个端点：`global`（读全部 pack + 分组 + 清单）、`workspace`（按 `sessionId` 解析 cwd 后返回该工作区的生效视图）、`apply`（写命令）。MCP 另有 `diag` 与 `servers`，保留。

命令集新增：

```ts
| { op: 'createPack'; name: string }
| { op: 'renamePack'; packId: string; name: string }
| { op: 'deletePack'; packId: string }
| { op: 'packItem'; packId: string; name: string; value: boolean | null }
| { op: 'packGroup'; packId: string; groupId: string; value: boolean | null }
| { op: 'bind'; cwd: string; packId: string | null }
| { op: 'addExtra'; cwd: string }
| { op: 'removeExtra'; cwd: string }
```

`bind` 的 `packId: null` 表示解除绑定、回到 default。

## UI

### 设置页

每个领域的 `settings.section` 增加分页控件，按钮组样式，与现有 skill 面板的分段控件同款（`border: 1px solid`、激活态 `rgba(127,127,127,0.22)` 底 + 主文字色）。不引新样式。

- skill / plugin / mcp：`分组 | 分包 | 工作区`，顺序固定，默认页取 `ui.defaultTab`。
- model：`模型 | 提示词 | 分包`（没有可分组对象，也没有工作区绑定页）。

分页控件之前先给一行「打开设置时默认显示」加三个单选，写 `{ op: 'defaultTab', value }`，初值来自 `ui.defaultTab`。**当前页与默认页是两个状态**：点分页只切当前页（不写盘），点单选才改默认页。两者耦合时，「临时看一眼分包」会顺手改掉用户的默认页。

「分组」页：只做结构——按分组折叠展示成员，展开后在行内改归属；组的新增/改名/删除也在这一页。**不放开关**：开关属于 pack，只在「分包」页出现。同一个开关有两个入口，两边状态迟早对不上。

页内自上而下是「新建分组 → 搜索 → 分组列表」：新建入口放到列表底下时，用户要滚到最底才看得见。

搜索同时匹配分组名：命中某个分组名时该组全部成员都算命中、整组展开。搜「三维」多半是想找那一组，而不是名字里恰好含这两个字的项。未分组不是一个分组，不参与组名匹配。

「分包」页（两块，自上而下）：

1. **pack 列表**：可新增、改名、删除（`default` 不可删改名），选中一个进入编辑。
2. **包内开关**：选中 pack 的项与组开关，每个开关三态（开 / 关 / 跟随）。跟随必须是一个独立的可点选项，不能与「开」共用按钮。选中 `default` 时只有两态——它是求值链的终点，没有上一层，未记录即内置缺省（开），显示成「开」。

「工作区」页：工作区列表（会话 cwd 去重 + `extra`），每行一个 pack 下拉；未选即「跟随 default」。页首写明「绑定只影响该目录下新开的会话」——策略在会话创建时求值，已经开着的会话不会换 pack。顺序是「说明 → 手动添加路径 → 列表」，手动添加是入口，放到列表底下等于没有。`extra` 里的路径可删除，会话来的路径没有删除入口。

### chip

保留四个 chip，各自 order 40–43。chip 文案是当前工作区绑定的 pack 名，未绑定显示 `Default`。

`ui.showChip === false` 时不注册该 chip。

**弹层**：不再只是一个选择器，而是这张 pack 的摘要，就地完成查看与切换：

1. 顶部一行：当前 pack 名；未绑定写「未指定，使用默认配置」。
2. **差异列表**：只列该 pack 相对 `default` 的差异——被关掉的技能、被开启的技能、被关掉的分组、被开启的分组。与 default 取值相同或从未记录的键不出现。没有差异时写「与默认相同」。
3. 底部：pack 下拉，选中即绑定；另有一项「解除绑定」。
4. 不放任何通往设置页的入口：不做「去设置」按钮，也不写快捷键提示。宿主没有对外暴露打开设置的接口（设置面板是宿主自己 `slots.register('sidebar.settings', { store })` 内建的，`actions.open()` 只在闭包里），写了也只是死路。

措辞按官方语气：短句、不用解释链式求值，不出现「跟随」「求值」这类词。

**窄宽度折叠**：面板变窄时，chip 从「图标 + 文字」退化为「仅图标」，与宿主输入框左下角的权限按钮行为一致。

观察对象不能是 chip 的直接父级：宿主插槽把 chip 包在一个与它等宽的容器里，那一层的 `clientWidth` 等于 chip 自身宽度，永远低于阈值，chip 就会在任何宽度下都只剩图标（实测症状）。做法是从 chip 向上最多 6 层，找第一个「宽度明显大于 chip 自身」的祖先——判据 `clientWidth > Math.max(chip.clientWidth * 2, 120)`，那一行才是会被侧栏与输入区一起压缩的可用宽度——用 `ResizeObserver` 观察它。找不到这样的祖先时才退回 `window.innerWidth` 并监听 `resize`。不要拿视口宽度做首选判据：侧栏展开会压缩主区，视口宽度不变而可用宽度变了。

阈值初值 420px，作为模块级常量而不是散落的魔法数；四个领域的取值必须一致，否则并排的四个 chip 会各折各的。

### 注册红线

所有 `ctx.slots.register` 的组件必须是稳定标识符。当前 `dsh-mcp-manager`、`dsh-plugin-manager` 在 `settings.section`、`sidebar.panellist`、`main`、`shell.overlay` 用了内联箭头函数，本次一并改成具名组件——这不是顺手优化，是 AGENTS.md 的硬红线，内联写法会让 React 每次渲染整棵重挂。

skill 的侧栏入口已废弃：`sidebar.panellist` 与 `main` 两个槽位不再注册，对应的 `Panel` 组件与「在侧栏显示入口」开关一起删除；设置页内嵌的 `GroupsPage` 已覆盖它原来的用途。

## 迁移

逐个领域，每个领域走同一条流水线：

1. 新代码落地，旧文件仍被读取（兼容读）。
2. 迁移脚本把旧数据写成 pack：
   - `$DSH_HOME/<旧包名>/global.json` 的 `items` / `groups` → `packs.default`；
   - 每个 `<cwd>/.dsh/<旧包名>.json` → 一个名为该目录 basename 的 pack，内容是那份文件的 `items` / `groups`，并在 `workspaces.json` 里绑定该 cwd。同名目录加序号后缀。
   - model 领域：`schemes.json` 的每个方案 → 一个 pack，`defaultSchemeId` 指向的方案内容 → `packs.default`；每个工作区的 `{ schemeId }` → 一条绑定。
3. 用户验收 UI 显示与迁移结果一致。
4. 验收通过后，由我方删除旧文件与旧目录。
5. 四个领域全部验收后，删除兼容读代码。

迁移脚本写在 `.tmp/pack-refactor/`，只读取旧文件、只写入新文件，绝不删除任何东西；删除动作单列为一步，由用户确认后执行。

## 改名清单

| 位置 | 现在 | 改为 |
|---|---|---|
| 目录 | `packages/dsh-skill-manager` | `packages/dsh-skill-pack` |
| 包名 | `@dreanzy/dsh-skill-manager` | `@dreanzy/dsh-skill-pack` |
| entry id | `dsh-skill-manager` | `dsh-skill-pack` |
| settings.section id | `skill-manager` | `skill-pack` |
| settings.section label | `Skill 管理` | `Skill Pack` |
| settings.section order | 60 | 60 |
| 路由前缀 | `/api/skill-manager/` | `/api/skill-pack/` |
| 状态目录 | `$DSH_HOME/skill-manager/` | `$DSH_HOME/packs/skill/` |
| chip id | `skill-manager-workspace` | `skill-pack-chip` |

plugin、mcp 同理，order 分别 61、62。model：`dsh-model-scheme` → `dsh-model-pack`，entry id `model-scheme` → `model-pack`，label `模型方案` → `Model Pack`，order 63。

四个 `order` 当前是 60 / 61 / 61 / 62，`model-scheme` 与 `plugin-manager` 冲突，本次一并修正。

npm 上四个旧包名均未发布（`npm view` 返回 404），改名没有外部安装者，不保留旧 id 别名。

## 验收

每个领域完成时，逐条检查：

1. 设置页出现「分组 | 分包 | 工作区」三页（model 为「模型 | 提示词 | 分包」），默认页符合 `ui.defaultTab`，且切页不改默认页。
2. 新建、改名、删除 pack；`default` 的删除与改名入口不存在。
3. 普通 pack 的开关三态、`default` 的开关两态，且「跟随」与「关」是两个不同操作。
4. 绑定一个工作区到某 pack 后，该工作区的新会话按 pack 生效；解除绑定后回到 default。
5. 切换一个工作区的绑定，不影响其他工作区。
6. 工作区目录下不再产生 `.dsh/` 文件。
7. chip 显示当前 pack 名；关掉 `showChip` 后 chip 消失，重启后仍不出现。
8. 迁移后，旧配置的每一项决定都能在新 UI 里找到对应值。

## 施工顺序

`skill → plugin → mcp → model`。

skill 与 plugin 同构，skill 先把「pack 求值链 + 三文件落盘 + 分页 UI + 迁移脚本」定型，plugin 照抄。MCP 要先补分组，是新代码。model 最后，它的数据结构与另外三个不同，且 `client.js` 有 2561 行，是全仓库最重的一块。

每个领域独立验收，未通过不进下一个。
