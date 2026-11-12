# 上游 API 观察清单

本项目对 `@deepseek-ai/*` 的脆弱依赖。检查 DSH 更新时先过这份清单，再做常规使用面比对。

三类条目：

| kind | 含义 | 判据字段 | 退役字段 |
| --- | --- | --- | --- |
| `replica` | 已手工复刻，怕上游改 | `check` | `retireWhen` |
| `fragile` | 在用，怕改名或改签名 | `check` | `retireWhen` |
| `blocked` | 想做，上游没开口 | `probe.upstream` + `probe.local` | `unblocksWhen` |

每条必有一个可执行判据和一个退役条件，缺一不收；条件达成就删，不留着。

## replica

### mcp-public-tool-name

- 包：`@deepseek-ai/dsh-mcp-client`
- 复刻对象：`publicToolName` —— `mcp__<server>__<raw>`，非法字符换 `_`，超 64 位截断并追加 12 位 SHA-256
- 位置：`packages/dsh-mcp-pack/src/public-name.ts:18`
- 起始版本：0.2.2-rc.1
- 为什么：宿主没导出公开名生成规则，本地按源码逐字复刻；规则一变，toolview 与命名空间会静默失准
- 判据：比对 dsh-mcp-client 公开名生成函数的前缀、字符集、长度上限与哈希长度
- 退役：上游导出该函数，或提供公开名校验入口

### mcp-server-name-pattern

- 包：`@deepseek-ai/dsh-mcp-client`
- 复刻对象：`SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/`
- 位置：`packages/dsh-mcp-pack/src/servers.ts:7`
- 起始版本：0.2.2-rc.1
- 为什么：宿主对 `serverName` 的约束，超出即无法挂载；本地逐字复刻
- 判据：比对 dsh-mcp-client 的 `SERVER_NAME_PATTERN` 字符集与长度
- 退役：升到 0.2.2-rc.2 后改为引用宿主导出的 `SERVER_NAME_PATTERN`
- 备注：0.2.2-rc.2 已导出该常量，升版即可退役；本机仍在 rc.1

### mcp-server-config-shape

- 包：`@deepseek-ai/dsh-mcp-client`
- 复刻对象：`ServerDef` 形状对齐宿主 `Config` —— stdio 的 `command`/`args`/`env`/`cwd`，streamable-http 的 `url`/`headers`
- 位置：`packages/dsh-mcp-pack/src/servers.ts:10`
- 起始版本：0.2.2-rc.1
- 为什么：托管定义直接写进宿主的配置结构，字段增减不会编译报错，只会在运行时被忽略或拒绝
- 判据：比对 dsh-mcp-client 的 `StdioConfig` 与 `StreamableHttpConfig` 字段
- 退役：改为 import 宿主的 `Config` 类型校验，或宿主导出构造函数

### model-defineTool-shape

- 包：`@deepseek-ai/dsh-tools`
- 复刻对象：`defineTool` 产出的对象形状 —— `name` / `output` / `parameters`（原始 JSON Schema）
- 位置：`packages/dsh-model-pack/src/tools.ts:12`
- 起始版本：0.2.2-rc.1
- 为什么：`@deepseek-ai/dsh-tools` 不在 dsh-model-pack 的依赖里，只能手工构造同形状对象
- 判据：比对 `packages/core/tools/src/schema.ts` 中 `defineTool` 返回对象的字段与 JSON Schema 形态
- 退役：把 dsh-tools 加进依赖并改用 `defineTool`，或宿主导出构造器

## blocked

### model-pack-team-steering

- 包：`@deepseek-ai/dsh-agent-team`
- 想要：编排层引导 AgentTeam —— 按档位指定团队成员模型，共享成员与任务面板
- 卡在：rc.1 无 `dsh-agent-team` 包，宿主不提供 `agentTeams` 服务
- 起始版本：0.2.2-rc.1
- 探测上游：查 `dsh-v*` tag 的 `packages/team/agent-team` 是否存在，导出是否含 `TeamService`，以及 `tool-agent-team` 的 inject 是否含 `agentTeams`
- 探测本机：读 asar 的 `node_modules/@deepseek-ai` 下是否有 `dsh-agent-team` 与 `dsh-tool-agent-team`
- 解除：上游提供 `agentTeams` 服务，且本机已具备该包
- 备注：0.2.2-rc.2 上游已提供（`packages/team/agent-team` 导出 `TeamService`，`tool-agent-team` inject 含 `agentTeams`、`subagents`）；本机 rc.1 尚无，属「可升级」而非「可动手」
