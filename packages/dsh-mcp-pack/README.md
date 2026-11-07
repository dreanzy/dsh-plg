# dsh-mcp-pack

按工作区控制 MCP 服务器的可见性与加载方式：哪些工程能用哪台 server、它的工具什么时候进入上下文。

## 它做什么

宿主里的 `@deepseek-ai/dsh-mcp-client` 一行一台 server，声明在 profile 的 `cordis.patch.yml` 或 preset 里。那些行默认全部挂载：连接建立、工具注册进全局工具表，模型每一轮都看得见全部工具 schema。

本插件接管这段：

- **按需加载**：`dynamic`/`lazy` 的行在启动时根本不挂载——连接不建立、工具不注册、宿主 `mcp-resources` 也没有目标可访问。模型先从名册里看到有哪些 server，再 `mcp_load` 需要的那些。
- **工具过滤**：一台 server 几十个工具、常用只有几个时，用 `!` 通配规则只放行要用的。
- **工作区分层**：同一个工程可以关掉某台 server，或不加载它，而不影响别的工程。

## 三种加载模式

| 模式 | 连接时机 | 工具怎么进上下文 | 载体 |
|---|---|---|---|
| `eager`（全部加载） | 宿主启动，由 `mcp-client` 挂载 | 全部 schema 常驻工具段 | 无 |
| `dynamic`（动态插入，默认） | 首次 `mcp_load` | 加载后把可见工具原生注册进调用方 agent 作用域 | `native` |
| `lazy`（延迟加载） | 首次 `mcp_load` | 一个都不注册；`mcp_load` 只返回 schema，经 `mcp_call` 调用 | `proxy` |

取舍：`dynamic` 绑定质量最好，代价是每次 `mcp_load` 都会让工具段变一次，请求前缀缓存随之失效。`lazy` 的工具列表永不变，前缀不失效，但每次调用多一层代理。

## 分包与分组

- **Pack（分包）**：一张具名的策略表。工作区只绑一个 pack，未绑定走内置的 `default`。策略不再落在工程目录里：`<cwd>/.dsh/mcp-manager.json` 已废弃，兼容读也已移除。
- **分组**：描述「哪些行是一类」，与 pack 正交。`groups.json` 的 `assignments` 以行键（`own:<name>` / `global:<name>`）为键。
- **逐字段独立求值**：

  ```
  enabled:     pack.rows[行].enabled ?? pack.groups[组] ?? default.rows[行].enabled ?? default.groups[组] ?? 开
  mode:        pack.rows[行].mode ?? default.rows[行].mode ?? dynamic
  tools:       pack.rows[行].tools ?? default.rows[行].tools ?? []
  description: pack.rows[行].description ?? default.rows[行].description ?? ''
  ```

  组级**只有开/关**一个布尔：组若也能设模式，立刻要回答「组说 dynamic、行说 disabled 算哪个」，那条合并规则没有便宜答案。所以模式、工具规则、描述只留在行级。
- 落盘三份，各自原子：`$DSH_HOME/packs/mcp/` 下的 `packs.json`（pack 名册 + UI 开关）、`groups.json`（分组与归属）、`workspaces.json`（工作区绑定）。
- 会话中途 `workingDirectory` 变化会重算该会话的策略。

## 面板

设置页 →「MCP Pack」：「分组 | 分包 | 工作区」三页。分组页只做结构（新增/改名/删除/改归属），开关只出现在分包页——同一个开关两个入口，两边状态迟早会不一致。工作区页把目录绑到 pack，未绑即跟随 `default`。

面板底部「运行期自检」展开后是插件的运行状态：宿主适配器是否取到、按需工具是否注册、哪些行被闸门摘掉、连接池里有哪些 key。

## 安装

```sh
dsh plugin --profile <profile> add @dreanzy/dsh-mcp-pack
```

从源码安装（需要 pnpm 允许该包执行构建）：

```sh
dsh plugin --profile <profile> add "github:dreanzy/dsh-plg#<sha>&path:/packages/dsh-mcp-pack"
```

## 托管区还是留在 patch

本插件管理两处来源，行键分别以 `global:` 与 `own:` 开头：

| | patch 里的行 | 面板托管 |
|---|---|---|
| 定义写在哪 | 你的 `cordis.patch.yml` | `$DSH_HOME/packs/mcp/servers.json` |
| 挂载方式 | 宿主的 Loader 组合 | `ctx.plugin` 运行时挂载 |
| 生命周期 | 跟宿主 | 跟插件：插件被禁用或重载时断开 |
| 面板可改定义 | 否（只读展示） | 是 |

**建议按改动频率分配，不必全部搬**：经常改 URL / args / env 的放托管区，长期不动的留在 patch。新加的用面板加，默认就进托管。

**一条硬约束**：不要把唯一可用的 server 放进托管区还设成 `eager`。那条路径绑在插件生命周期上，插件掉线它就断；patch 里的行不会。

**安全提醒**：`servers.json` 与你的 `cordis.patch.yml` 一样会把连接参数（包括 URL 里的 token）明文存盘。它位于 `$DSH_HOME`，不在任何仓库的 `.gitignore` 覆盖范围内，不要提交出去。

## 已知限制

1. **行定义不由本插件创建**。它只控制已有行的可见性与加载方式；server 的 `command`/`url`/`env` 仍写在你的 `cordis.patch.yml` 里。
2. **闸门按 `default` pack 的判断执行**。挂载是进程级的事，与会话所在目录无关；工作区差异由 per-agent 的 `restrict` 屏蔽处理。
3. **切换模式有一次连接中断**：提交后闸门会真的 kill 子进程或断开 HTTP 连接。
4. **`eager` 行不受工具过滤影响**：它由 `mcp-client` 整台挂载，本插件没有插手的点。
5. **按需模式拿不到 server instructions**：那是挂载路径才注册的段。需要就把它设成 `eager`。
6. 连接池不跨宿主重启，重启后需要重新 `mcp_load`。

## 开发

```sh
pnpm typecheck
pnpm test
pnpm build
```

决策记录见 `docs/adr/`，术语见 `GLOSSARY.md`。