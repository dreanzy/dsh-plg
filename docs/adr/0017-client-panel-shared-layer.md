# 面板共享层：构建期拼接，产物入库

## 背景与决定

[ADR-0007](./0007-shared-core-package.md) 把服务端骨架收进了 `@dreanzy/dsh-pack-core`，同时把**面板组件的共享**延后，并写明触发条件：「等真的改四遍、且出过一次不一致再谈构建期拼接」。

两个条件都已成立：抽 core 之后 88 次提交里 `client.js` 仍被改 30 次；`createSignal` 在四份里是 23/23/23/17 行，`Picker` 是 88/89/83/79 行，命名也从 `Warnings + StaleKeys` 漂成 `StaleKeysNotice + WarningsNotice`。四份 `client.js` 合计 14237 行，其中 skill 与 plugin 的行级覆盖 79%、与 mcp 60%。

决定：

**1. 构建期拼接。** 新增 `scripts/client-shared/panel-core.js`（共享骨架）与 `scripts/build-client.mjs`（拼接器）。各包新增 `client/panel.js`（业务面），产物 `client/client.js` 由两者拼成：

```
window.__ModuleLoader__.load({ id, factory(require) { <panel-core> <panel> } })
```

两个占位符：`__PREFIX__` 是 CSS 类名前缀（等于包目录名），`__PACK__` 是 API 路径段。拼接器零第三方依赖，做三条断言（共享层不含 import/export、业务面不含 export、占位符全部替换）。

**2. 共享层不进 `dsh-pack-core`。** 那是浏览器半边，与服务端骨架是两件事。放进 core 会让只想要服务端能力的包也被迫带一份浏览器代码。

**3. 产物入库。** 这一条修正了原计划的「产物不入库」，原因是硬约束：源码安装的路径是 `github:<owner>/<repo>#<sha>&path:/packages/<pkg>`，npm 只取该子目录并跑 `prepare`——`scripts/` 与共享层在安装时**根本不存在**，构建跑不起来。因此构建只能在开发期做，产物随源码一起发布。

**4. 一致性由检查守住，而不是靠人记得。** `check-panels.mjs` 新增一条：按源码重新算出产物，与磁盘上的比对，不一致直接失败。这条检查是本项目里唯一能防止「改了 `panel.js` 忘了构建」的机制。

**5. 检查对象拆开。** 加载测试查产物（宿主真正吞下的文件），纪律检查（`must` / `mustNot` / 界面基调红线）查源码（`panel-core.js` + `panel.js`）。混在一起查，共享层会被每个包的计数各算一遍。

## 考虑过的替代方案

**客户端运行时 `require` 另一个插件 row。** 否掉，理由同 ADR-0007：组合阶段会因「缺失提供方」让四个面板一起起不来，正踩客户端红线。

**引入 esbuild / rollup。** 否掉：只为把两份手写 JS 接起来就引入一套构建配置与新的失败方式，而产物必须仍是能被 `__ModuleLoader__` 直载的单文件——打包器的产出还要再裁一遍。

**字符串替换之外的结构化拼接（正则剥 import/export）。** 否掉：靠正则改代码，剥漏一处就是语法错误；纯文本约定加一条断言就够。

**产物不入库。** 见上文第 3 条，与现有安装方式不兼容。若将来改为整仓源码安装，这条可以重新考虑。

## 后果

- 开发流程多一步：改 `panel-core.js` 或 `panel.js` 后跑 `node scripts/build-client.mjs`。忘记时 `check-panels` 会红。
- 各包的 `test` 脚本前置了构建，本地不会测到旧产物；`prepare` 不含构建（源码安装时不可用）。
- `files` 从 `client` 收窄到 `client/client.js`，`panel.js` 不随包发布。
- `mutation.mjs` 的 7 条客户端变异锚定在 `client.js` 的文本与行号上，产物化后行号不稳，需要迁到 `panel-core.js` 与各包 `panel.js`。
- 迁移分批：skill 与 plugin 先，mcp 次之（四字段行是第一次真实压力），model 最后（它的设置页把三页塞在一起，需要先拆出提示词页）。
- 已知局限：这一批只迁移了 skill。plugin / mcp / model 仍在各自的复制品上，直到后续提交完成。

## 参考

- [ADR-0007](./0007-shared-core-package.md)：服务端半边先落地，面板共享延后并留下触发条件。
- [ADR-0006](./0006-pending-changes-before-commit.md)：待保存改动的语义，是这次共享层 `apply` 的核心。
- `docs/ui-baseline.md`：界面基调红线，检查对象从产物改到源码后仍由 `check-panels` 执行。
