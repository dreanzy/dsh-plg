# 0002 闸门先遮蔽 disabled，再处置 fiber

## 背景与决定

`dynamic`/`lazy` 要做到「启动零连接、工具根本不存在」，必须让 Loader 不挂载那行——只靠 `restrict` 屏蔽是遮不住 `mcp-resources` 的，它按挂载注册，屏蔽工具表对它无效。

摘掉一个 entry 的做法是 `fiber.dispose()`，但这里有个陷阱：Loader 在 `internal/plugin` 的自处置分支里，若 `entry.disabled` 为假，会执行 `entry.options.disabled = true` 再 `tree.commit(...)`——**把闸门状态写进用户的 `cordis.patch.yml`**。

决定：**先遮蔽，再处置**。用 `Object.defineProperty(entry, 'disabled', { value: true })` 在实例上盖住原型 getter，`fiber.dispose()` 时 Loader 读到「已 disabled」就直接 return，不写文件。恢复时 `delete` 自有属性即可回到原型 getter，再用 `entry.update({ disabled: false }, false, true)` 让它重新 init。

## 考虑过的替代方案

- **直接改 `entry.options.disabled` 并 commit**：会写用户文件，明确否掉。
- **只做 `restrict` 屏蔽，不做闸门**：实现最简单，但 `mcp-resources` 仍能看到每台 server 的资源，模型也能顺着资源反推出 server 存在。语义上「没加载就不该存在」做不到。
- **在组合层预先写入 `disabled: true`，由插件负责挂载**：要改用户的 profile 配置，等于接管他的组合文件，与本插件「只读用户定义」的边界冲突。

## 后果

- 闸门状态只存在于进程内存，宿主重启即恢复原状；插件卸载时不留任何痕迹。
- 依赖两个私有约定：`loader/entry-init` 在 `options` 赋值前发出（故延后一个 microtask 再读），以及 `internal/plugin` 的写回条件。**宿主升级必须复验这两条**。
- 验证方案固定为：隔离 profile 里放一条 stdio 探针行，启动后检查 `suppressed` 命中、探针进程数为 0、`cordis.patch.yml` 的 SHA-256 与启动前一致。第三条是关键，前两条都可能因为「连接失败自己退出」而假通过。
- 提交模式变更会真的 kill 子进程或断开 HTTP 连接，用户会看到一次连接中断。
