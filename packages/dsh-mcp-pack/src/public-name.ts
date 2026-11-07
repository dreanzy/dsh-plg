import { createHash } from 'node:crypto'

/** DeepSeek 函数名上限：这是线上契约，不是配置项。 */
const MAX_PUBLIC_NAME_LENGTH = 64
/** 合法字符集。 */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
/** 归一化有损时附在末尾的哈希长度。 */
const HASH_LENGTH = 12

/**
 * 复刻宿主的公开工具名契约。
 *
 * 同一个工具在不同载体下必须是同一个名字，否则按 `mcp__<server>__` 前缀挂的
 * toolview 与命名空间都会失准。所以这里逐字复刻 `dsh-mcp-client` 的规则：
 * 干净情况下就是 `mcp__<serverName>__<rawName>`；一旦发生字符替换或截断，
 * 追加 12 位 SHA-256，保证不同身份不会塌成同一个名字。
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}
