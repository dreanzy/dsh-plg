# 02 方案数据结构与求值链

Status: ready-for-agent
Type: task
Blocked by: 01

## 目标

两层配置文件与求值链的纯函数实现，不碰宿主事件。

## 范围

`src/scheme.ts`（类型、解析、校验、序列化）与 `src/policy.ts`（`loadState(cwd)`、`resolve(state, cwd)`、`applyCommands(cwd, commands)`）。读写用 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` + `writeFileAtomic`，模式 0600/0700，路径由 `@deepseek-ai/dsh-home-paths` 的 `dshHomePath('model-scheme', 'schemes.json')` 与 `<cwd>/.dsh/model-scheme.json` 给出。

求值链严格按 spec §4：工作区 schemeId → 全局 defaultSchemeId → 出厂方案。坏 JSON 降级为出厂并附 warning 文本。

## 验收

`test/policy.test.js` 覆盖 spec §9-1 六种情形，各自断言返回的方案 id 与 warnings。坏 JSON 时不得抛异常。

## 边界

不 import 任何宿主服务；不读宿主事件。所有函数对同一输入幂等。