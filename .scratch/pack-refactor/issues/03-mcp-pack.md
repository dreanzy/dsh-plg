# 03 — dsh-mcp-pack

Status: needs-triage

## 范围

`packages/dsh-mcp-manager` → `packages/dsh-mcp-pack`。除照抄 01 的骨架外，这一票有自己的一块新代码：

1. **补分组**：新增 `groups.json`，`assignments` 以行键（`own:<name>` / `global:<name>`）为键。本包目前完全没有 group，这是新增数据结构，要新写解析、序列化、增删改与指派命令。
2. **pack 形状**：

```ts
interface McpPack {
  readonly name: string
  readonly groups: Readonly<Record<string, boolean>>   // 组级只决定开/关
  readonly rows: Readonly<Record<string, RowPolicy>>   // 行级可设 enabled/mode/tools/description
}
```

组级只做开合，四字段只留在行级——这是 spec 里定下的取舍，不要在实现时「顺手」让组也能设 mode。

3. `servers.json`（托管连接定义）迁到 `$DSH_HOME/packs/mcp/servers.json`；`diag.json` 一并迁移，它只是运行期自检快照。
4. 求值链保持逐字段：`pack.rows[行][字段] ?? default.rows[行][字段] ?? 内置默认`。**不要**改成整行求值，现有 policy.ts 里的注释说明了理由。

## 前置

01 验收通过。

## 依赖

- [spec.md](../spec.md)
- [01-skill-pack.md](./01-skill-pack.md)
