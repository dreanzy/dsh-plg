# 10 预加载闸门：真正不挂载

Status: resolved
Type: task
Blocked by: 04, 07

## 目标

`dynamic`/`lazy` 的行在启动时根本不挂载，进程零启动，`mcp-resources` 也没有目标可访问。

## 实现

- `src/suppress.ts`：`suppress` 遮蔽实例的 `disabled` 再处置 fiber；`release` 撤遮蔽并 `update({ disabled: false })`。
- `src/gate.ts`：订阅 `loader/entry-init`（options 赋值前发出，故延后一个 microtask），按策略逐行处置；首次启动与每次 `/apply` 写入后各跑一次。
- 策略未就绪时 `modeOf` 返回 null，闸门不动。

## 验证

隔离 profile 加一条 stdio 探针行（`node -e "setInterval(...)"`），启动后：

- `suppressed: ["probe"]`
- 探针进程数 0
- `cordis.patch.yml` 的 SHA-256 与启动前完全一致
- `gate.entryInitEvents: 108`、`reconciles: 5`

第三条是关键：遮蔽先于处置，Loader 的写回分支被 `if (entry.disabled) return` 挡住。

## 已知限制

- `/apply` 后跑闸门会真的 kill 子进程，切换模式有一次连接中断。
- 闸门只按全局层策略判断（挂载是进程级，与工作区无关），工作区差异仍由 `shield.ts` 处理。
- 恢复 `eager` 时 `entry.update` 让 Loader 重新 init，与 `mcp_load` 起的连接不共享（两个进程），下次 unload 后收敛。
