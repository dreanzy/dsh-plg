/**
 * core 内部的形状守卫。
 *
 * 不导出到包外：它们是实现细节，不是 interface。四个包各自也有一份（全仓 14 处），
 * 那些是另一个候选的事——这里只服务 core 自己的两个模块。
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}
