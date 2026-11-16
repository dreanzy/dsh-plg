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
- 判据：比对 dsh-mcp-client 的 `SERVER_NAME_PATTERN` 字符集与长度，并确认入口仍导出该常量
- 退役：上游把该常量移出入口后，本地复刻成为唯一来源，条目转 `fragile`；或上游提供公开名校验入口
- 备注：0.2.2-rc.3 入口已导出，但该导出登记在 `scripts/plugin-entry-existing-exports.ts` 的债务清单里（原文 "existing debt, not an approved exception"），随时可能被清理，不能当稳定 API 依赖

### mcp-server-config-shape

- 包：`@deepseek-ai/dsh-mcp-client`
- 复刻对象：`ServerDef` 形状对齐宿主 `Config` —— stdio 的 `command`/`args`/`env`/`cwd`，streamable-http 的 `url`/`headers`；0.2.2-rc.3 起宿主另有 `startupTimeoutMs`/`closeTimeoutMs`/`expandTemplates`，本地未复刻
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

当前无条目。
