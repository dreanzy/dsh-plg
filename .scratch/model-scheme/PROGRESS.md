# 进度：全部 ticket 完成

> 收尾于 2026-11-06 12:5x。9 个 ticket 全部完成。

## 状态

| # | Ticket | 状态 |
|---|---|---|
| 01 | 包骨架 | 完成 |
| 02 | 方案数据结构与求值链 | 完成 |
| 03 | 编排层与会话接入 | 完成 |
| 04 | `subagent_tier` 工具 | 完成 |
| 05 | 委派提示词段 | 完成 |
| 06 | 面板数据路由 | 完成 |
| 07 | 设置页 | 完成 |
| 08 | 模型位方案名 | 完成 |
| 09 | 文档与 ADR | 完成 |

## 验收（主会话实跑）

```
build         exit 0
test          95 tests / 94 pass / 1 skip (Windows POSIX mode) / 0 fail
client 语法   exit 0
check-ui-vars ok（4 个面板）
check-panels  ok（4 个面板，派生断言全过）
```

## 已安装

`dsh plugin --profile desktop add` 成功：
- `~/.dsh/profiles/desktop/package.json` 的 bundles 末尾有 `@dreanzy/dsh-model-scheme`
- `node_modules/@dreanzy/dsh-model-scheme` 是 Junction → 本地包，改 client.js 即时可见
- 需重启 DSH 才加载

## 已知代价

1. **官方 `model.badge` 角标不再显示**：08 替换了 `conversation.input.model.label` 的 trigger 渲染，官方角标逻辑在被替换的部分里。本部署的模型没有角标，暂无影响。
2. **方案名前缀最长迟 15s 出现**：label 缓存 15s 增量刷新（页面隐藏时跳过）。
3. **出厂方案为空**：装上不配置 = 行为完全不变。这是设计选择。

## 重启后的验证步骤

1. 设置 → 插件 → 模型方案，新建方案，配四档与思考等级
2. 绑定当前工作区（或设全局默认）
3. 新开会话 → 模型位应显示「方案名 · 模型名」
4. 让 agent 派子代理 → 应调用 `subagent_tier` 而非官方 `subagent`
5. 子代理插件的设置页应显示官方工具已被屏蔽的说明

## 环境风险（与本次开发无关）

`@wenaixi/dsh-ponytail@5.6.2` 与 `dsh-ops@0.4.4` 的 engines 不覆盖 0.2.2-rc.1，重启时会被 profile 拒绝加载，除非做版本豁免。
## 追加：内置提示词与自定义覆盖（第二轮）

| 项 | 结果 |
|---|---|
| 内置编排段 + 四档判定线索 | `prompt.ts` 的 `BUILTIN_PROMPT`，整段 268 token（上限 350） |
| 用户覆盖 | `$DSH_HOME/model-scheme/prompts.json`，逐键合并，空串 = 跟随内置并拒绝写入 |
| 新命令 | `putPrompts` / `resetPrompts` |
| 面板 | 「提示词」分区（编排段 + 四档 label/text + 恢复内置），`client.js` 增至 2537 行 |
| 档名 | 统一为 侦察 / 速办 / 攻坚 / 深算（含测试 fixture 与 spec） |
| 验收 | build 0 / typecheck 0 / 119 用例（118 过 1 skip）/ client 语法 0 / 两个 UI 静态检查 ok |

未实现的项：用户覆盖内容的「不得含 provider/model 名」**不做硬校验**——插件内无权威 provider 名单，硬校验只会误杀。面板仅在检测到 `a/b` 形式时给不阻止保存的提示。

待办：skill 未删。建议先跑两周确认模型行为，再删 `my-dsh-subagent-route` / `my-dsh-subagent-route-gpt`，并把定档判据并入 `my-dsh-subagent-delegate` 或直接删除（内置段已含）。

## 评审后修正（2026-11-06）

| 项 | 变更 |
|---|---|
| 测试脚本 | `package.json` 补 `test`：此前 `pnpm -r test` 静默跳过本包，五个测试文件从不执行 |
| 竞态 | `hooks.ts` 在 `await loadState` 后校验 agent 仍存活，避免 disposer 挂到已删除的 state |
| 失败路径 | 坏 JSON 的 warning 带上文件路径（spec §6.4） |
| 组件稳定性 | skill-manager 的 chip 由内联箭头改为稳定标识符 |
| 文档 | spec §1/§2/§6.1/§6.3.1/§6.4/§7/§8/§9 与 AGENTS.md 宿主红线对齐实现；补 README.en.md 与配置、安装段 |
| 验收 | build 0 / typecheck 0 / 122 用例（121 过 1 skip）/ 两个 UI 静态检查 ok |
