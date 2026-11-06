# 01 — dsh-skill-pack

Status: ready-for-agent

## 范围

按 [spec.md](../spec.md) 把 `packages/dsh-skill-manager` 重构为 `packages/dsh-skill-pack`。这是四个领域里的第一个，骨架在这里定型，后三个照抄。

1. 改名：目录、包名、entry id、settings.section id 与 label、路由前缀、chip id（见 spec「改名清单」）。
2. 数据结构：新增 `Pack { name, items, groups }`；`Command` 增加 `createPack` / `renamePack` / `deletePack` / `packItem` / `packGroup` / `bind`。
3. 落盘：`$DSH_HOME/packs/skill/{packs.json,groups.json,workspaces.json}`，`<cwd>/.dsh/skill-manager.json` 停止写入。
4. 求值链：`pack.items ?? pack.groups ?? default.items ?? default.groups ?? true`，工作区层退役。
5. UI：设置页 `分组 | 分包` 两页，分包页三块（pack 列表 / 包内开关 / 工作区绑定）；chip 显示当前 pack 名并支持 `showChip` 关闭。
6. 工作区清单来自 `ctx.remote.session.list()`，`workspaces.json` 只存绑定与 `extra`。
7. 注册组件全部改为稳定标识符（当前 3 处内联箭头）。
8. 兼容读旧文件，迁移脚本写在 `.tmp/pack-refactor/`。

## 验收

见 [spec.md](../spec.md) 的「验收」八条。另加一条：`clear` 前三包共用的 `normalizeCwd` 行为要能在测试里断言，因为 `workspaces.json` 用它当键。

## 依赖

- [spec.md](../spec.md) 全文。
- ADR 0002 的零共享仍然有效：不抽共享包，不做跨领域 pack。
