/**
 * 安静地处置一个可能返回 Promise 的 disposer。
 *
 * `try/catch` 只能捕获同步抛错。Cordis 的 `fiber.dispose()` 断开 MCP 连接时是异步的
 * （内部有 `await Promise.race`），子进程 kill 失败或 stdio 写失败时会 reject。
 * 裸 `void dispose()` 让这个 rejection 无人接管，成为 unhandledRejection；Node 22+
 * 默认 `--unhandled-rejections=throw`，进程直接退出——DSH 桌面端整个崩掉。
 *
 * 处置失败没有可回滚的状态：遮蔽已生效、连接已断，下一次装配会重新拉起。
 */
export function disposeQuietly(value: unknown): void {
  try {
    const result = typeof value === 'function' ? (value as () => unknown)() : value
    if (result instanceof Promise) void result.catch(() => undefined)
  } catch {
    // 同步抛错同样无处可去。
  }
}
