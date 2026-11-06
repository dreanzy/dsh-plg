/** 宿主的 MCP 客户端插件名。一个实例连一台 server。 */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Loader entry 在本模块用到的面。 */
export interface EntryLike {
  options?: Record<string, unknown> | undefined
  fiber?: { dispose?: () => unknown } | undefined
  update?: ((options: Record<string, unknown>, create?: boolean, force?: boolean) => Promise<void>) | undefined
}

function configOf(entry: EntryLike): Record<string, unknown> | null {
  const config = entry.options?.['config']
  return typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : null
}

/** 这条 entry 是不是一台 MCP server。 */
export function isMcpEntry(entry: EntryLike): boolean {
  return entry.options?.['name'] === MCP_CLIENT_MODULE
}

/** 该 entry 的 serverName；不是 MCP 行时返回 null。 */
export function entryServerName(entry: EntryLike): string | null {
  if (!isMcpEntry(entry)) return null
  const name = configOf(entry)?.['serverName']
  return typeof name === 'string' && name !== '' ? name : null
}

/** 是否已被我们遮蔽（自有属性存在即算）。 */
export function isSuppressed(entry: EntryLike): boolean {
  return Object.hasOwn(entry, 'disabled')
}

/**
 * 摘掉一行。
 *
 * **顺序是硬要求：先遮蔽 `disabled`，再处置 fiber。** Loader 在 `internal/plugin`
 * 的自处置分支里先看 `entry.disabled`，为真就直接 return；为假才会
 * `entry.options.disabled = true` 并 `tree.commit(...)` 写回文件。用户的行写在
 * `cordis.patch.yml` 里，顺序反了就是把我们的闸门状态写进他的配置。
 *
 * 遮蔽用的是实例自有属性：`Entry.disabled` 是原型上的 getter，自有属性天然覆盖它，
 * `delete` 即恢复。
 */
export function suppress(entry: EntryLike): boolean {
  if (isSuppressed(entry)) return false
  Object.defineProperty(entry, 'disabled', { value: true, configurable: true, enumerable: false })
  try {
    // 已经挂载过的行：立刻断开连接并注销工具。
    void entry.fiber?.dispose?.()
  } catch {
    // 处置失败不致命：遮蔽已生效，下一次装配时它不会被重新拉起。
  }
  return true
}

/**
 * 恢复一行：撤掉遮蔽并让它重新 init。
 *
 * `Entry.update` 不写文件（写文件的只有 `EntryTree.create/update/remove` 与 fiber 自处置），
 * 所以这里传真实的 `disabled: false` 是安全的。
 */
export async function release(entry: EntryLike): Promise<void> {
  if (!isSuppressed(entry)) return
  delete (entry as { disabled?: unknown }).disabled
  try {
    await entry.update?.({ disabled: false }, false, true)
  } catch {
    // 恢复失败留给宿主下一次装配，不在这里抛。
  }
}
