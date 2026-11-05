# 09 插件托管 include 文件

Status: wontfix（改由方案 B 取代）
Type: task
Blocked by: 01, 02

## 结论

原方案（建 `mcp-manager.cordis.yml` + 往用户 `cordis.patch.yml` 插 `cordis:include` 行）**不做**。

否决理由：那要程序改写用户手写的 YAML。缩进、引号、锚点、注释任一处出错，整个 profile 起不来——与「闸门绝不写回」是同一条底线的两面。

## 替代方案（已实现）

运行时挂载：定义存 `$DSH_HOME/mcp-manager/servers.json`，用 `ctx.plugin({ name, inject, apply }, config)`
动态挂 `dsh-mcp-client`。完全不碰任何 cordis 文件。

见 `src/servers.ts`、`src/mount.ts`，以及 `POST /api/mcp-manager/servers`。

隔离验证：`owned: ["echo-managed"], mounted: ["echo-managed"]`。
