# 08 面板 UI

Status: resolved
Type: task
Blocked by: 01

## 交付

- `client/client.js`：手写 `React.createElement`，四个槽位各用独立 id。
  - `settings.section`（全局层）与 `sidebar.panellist` + `main`（全局层面板）
  - `conversation.input.right` + `shell.overlay`：带 sessionId 的弹层，读写工作区层
- 行卡片：server 名、transport、来源、「本层已覆盖 / 本层跟随」、三段模式 + 「跟随」按钮、开关、描述输入。
- 顶部常驻三档模式说明；底部「运行期自检」折叠区。
- 草稿与保存（ADR-0005 模式），保存时一条批处理。

## 踩过的坑（都已修）

1. **槽位 id 必须互不相同**，只有 `sidebar.panellist` 的 id 与 `main` 的 `key` 必须**相同**——前者是去重，后者是配对。改一处漏另一处，表现是「点图标没反应」。
2. **`api.workspace` 缺失**：只在弹层路径用得到，单测与设置页都不碰，一渲染就抛错，整个 slot entry 崩掉，表现是「按钮点不开」。
3. **`nullable` 命令的语义**：`dynamic` 曾被翻译成 `null`（＝删覆盖），于是工作区层无法显式指定 dynamic；`enabled` 的「开」也曾发 `null`，导致全局关着的行永远打不开。现在三档发确定值，另设「跟随」按钮发 `null`。
4. `showSidebarEntry` 命令没有 `rowKey`，必须在 rowKey 校验**之前**分流，否则 Layer 开关永远被拒。

## 未做

工作区层的托管 server 定义编辑（定义只存全局一份，工作区只覆盖策略）。
