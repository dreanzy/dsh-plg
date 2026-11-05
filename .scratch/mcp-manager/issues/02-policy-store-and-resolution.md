# 02 策略存储与求值链

Status: resolved
Type: task
Blocked by: 01

## 目标

工作区层与全局层的策略读写，以及「工作区 → 全局 → 默认」的三件事求值（允许、模式、工具规则）。

## 范围

- `src/policy.ts`：解析/序列化两层 JSON；`resolve(rowKey, layers)` 返回 `{ enabled, mode, tools, from }`。
- `src/store.ts`：`transact`（先建父目录、再 `withFileLock`、锁内 `writeFileAtomic`）。
- 路径：`<cwd>/.dsh/mcp-manager.json`、`$DSH_HOME/dsh-mcp-manager/global.json`。
- 命令模型：绝对状态，无版本号；单项幂等。
- 测试：求值链优先序、损坏 JSON 降级为空策略、超时锁行为。

## 验收

- 求值链单测覆盖「工作区覆盖全局」「缺失回落默认」「损坏文件不抛穿」。
- `transact` 在父目录不存在时也能写成功。

## 边界

- 只写这两个文件，不碰用户已有的 `mcp.cordis.yml`。
## Answer

策略存储与求值链已落地。

产出：
- `src/policy.ts`：`parseLayer`/`serializeLayer`/`resolveRow`/`resolveAll`/`hasLayerEntry`。
- `src/store.ts`：`transact`（先建父目录、再 `withFileLock`、锁内 `writeFileAtomic`）、`loadLayers`、`applyCommands`。
- 路径：`<cwd>/.dsh/mcp-manager.json`、`$DSH_HOME/dsh-mcp-manager/global.json`。
- `test/policy.test.js`（8 项）与 `test/store.test.js`（5 项）。

三处实现决定：
- 三个字段各自独立求值并各记来源（`sources.enabled/mode/tools`），`from` 取最具体层。
- 行策略三字段全空时整条删除，不留空对象冒充覆盖。
- 加锁顺序固定：全局 → 工作区，两者各自一把锁。
