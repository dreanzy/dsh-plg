# 团队任务板引导：结论与改动

状态：已实施（2026-11-25）

## 1. 问题

现象：Agent Teams 默认开启，但模型几乎不调 `team_task_*`，只用 `subagent_tier` 派子代理。

## 2. 证据

本机 profile `agent-team.defaultEnabled: true`。最近 40 个本工作区会话的统计：

- 12,825 次工具派发中，`subagent_tier` 29 次，`subagent_fork` 0，裸 `subagent` 0，`wait_agent` 55，`team_task_*` 6。
- 21 个会话注入了官方 `team:policy`，工具在 PTC 会话里实测可用（`typeof` 为 `function`）。开着、可用、几乎不用。
- 6 次任务板全落在 2026-11-16 的两个会话，此后 0 次。
- 唯一真正并行派发的会话也是 2026-11-16，12 次 `subagent_tier`、8 组间隔 <5 秒、任务板 0 次；但它是**只读**调研任务。

结论：按最终判据，过去两周的零使用没有违规案例——缺的是「并行写同一工作区」这个场景本身，以及一段告诉模型该场景存在的判据。

## 3. 已定决策

1. 价值主张：并行写同一工作区时的范围隔离与依赖排序（不是 durable 记录，也不是命名语法糖）。
2. 判据：同一轮 ≥2 个 teammate **且写同一工作区**时建板并标 `write_scopes`；单发不建；只读并行不建，无例外。
3. 判据只写「何时」，不写流程步骤。claim/revision 流程由官方 `team:policy` 承担，否则会出现第二个事实源。
4. 保留原有三条纠偏（`subagent_tier` 取代被 deny 的 `subagent`、名字做 owner、`subagent_fork` 限上下文），并补上 `list_agents` 这个 owner 来源。
5. 加 `TEAM_SECTION_MAX_TOKENS = 260`，挡住后续继续堆。
6. GLOSSARY 不动（无新术语，「团队模式」条目说的是宿主默认，与本机配置不矛盾）；ADR 不写（提示词随时可逆转，不满足「难以逆转」）。

## 4. 否决的方案

- **新增 order 2900 的独立段**：与官方 600 段构成两个事实源；且 2900 紧邻委派段 2850，模型读成二选一；宿主段序常量分散在各包，挑错位置不易发现。
- **改 `subagent_tier` 工具描述**：`TIER_DESCRIPTION_MAX_TOKENS = 200` 已占大半；团队关闭时工具仍在，会指向不存在的 `team_task_*`。
- **让 `subagent_tier` 自动建板**：会在只想派一个只读子代理时污染任务板；派发本身不携带 `subject`/`write_scopes` 语义。
- **改委派段那句「scope by write ownership」去指路任务板**：非团队会话里 `team_task_*` 不存在，指名工具会指向空中。

## 5. 改动

1. `packages/dsh-model-pack/src/prompt.ts`：`TEAM_SECTION_TEXT` 换为判据版，新增 `TEAM_SECTION_MAX_TOKENS = 260`。
2. `packages/dsh-model-pack/test/hooks.test.js`：团队段断言补 `team_task_create` / `write_scopes` / 只读边界。
3. `packages/dsh-model-pack/test/prompt.test.js`：新增团队段 token 上限与「不含 claim」断言。
4. `docs/dsh-api-watch.md`：新增 `team-policy-carries-claim-flow`，记录对官方流程文本的依赖。

成本：团队会话每个请求 +47 token（110 → 157）；团队关闭时该段为空串，零成本。

## 6. 验收

- `node --test --test-isolation=none test/`（包内）：185 项，184 pass、1 skip、0 fail。
- `pnpm e2e`：见提交前的运行结果。
