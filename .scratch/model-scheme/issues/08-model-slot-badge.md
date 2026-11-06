# 08 模型位方案名展示

Status: ready-for-agent
Type: task
Blocked by: 07

## 目标

在官方 composer 模型位触发按钮上显示「方案名 · 模型名」，不接管任何交互。

## 范围

`client/client.js` 里注册 `conversation.input.model.label` 的 placement 为 trigger。只渲染非交互内联内容。方案名由 read 拿到的当前会话方案决定；拿不到时退回纯模型名。

## 验收

选中模型后触发按钮显示方案名前缀；切换方案后刷新显示更新；官方点击、搜索、键盘导航、无障碍标签行为不变（逐项手工确认）。

## 边界

不改 menu 与 option 两个 placement；不在该 slot 挂任何 onClick。