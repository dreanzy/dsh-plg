/** 一条规则编译出来的集合：保留什么、隐藏什么。两边都空等于不过滤。 */
export interface ToolFilter {
  readonly keep: readonly RegExp[]
  readonly drop: readonly RegExp[]
}

/** 空规则：什么都不隐藏。 */
export const NO_TOOL_FILTER: ToolFilter = { keep: [], drop: [] }

/** 排除标记。 */
const EXCLUSION_PREFIX = '!'

/**
 * 读一条规则的条目。
 *
 * 值来自用户可编辑的文件，所以每条坏条目都跳过而不是抛错：一套规则解析成空
 * 等于不过滤——打字错误不该静默藏掉一台服务器的全部工具。裸字符串也接受，
 * 因为文件是手写的。
 */
export function toolRuleEntries(value: unknown): readonly string[] {
  const entries: readonly unknown[] = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value
      : []
  const text: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed !== '') text.push(trimmed)
  }
  return text
}

/**
 * 把一条规则编译成锚定正则。
 *
 * `*` 匹配任意长、`?` 匹配一个字符；其余正则元字符全部转义，大小写敏感。
 * 这样规则是「工具名的通配」而不是「正则子集」，用户不用知道正则语法。
 */
function compilePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  const wildcard = escaped.split('*').map((part) => part.split('?').join('.')).join('.*')
  return new RegExp(`^${wildcard}$`, 'u')
}

/** 解析一条规则。 */
export function parseToolFilter(value: unknown): ToolFilter {
  const keep: RegExp[] = []
  const drop: RegExp[] = []
  for (const entry of toolRuleEntries(value)) {
    if (entry.startsWith(EXCLUSION_PREFIX)) {
      const pattern = entry.slice(EXCLUSION_PREFIX.length).trim()
      if (pattern !== '') drop.push(compilePattern(pattern))
      continue
    }
    keep.push(compilePattern(entry))
  }
  return { keep, drop }
}

/** 这套规则是否隐藏了什么。 */
export function filterHidesAnything(filter: ToolFilter): boolean {
  return filter.keep.length > 0 || filter.drop.length > 0
}

/**
 * 一个工具名是否被放行。
 *
 * 判定顺序固定：先看 drop（显式排除优先），再看 keep（有白名单就只放行命中的）。
 */
export function admits(filter: ToolFilter, name: string): boolean {
  if (filter.drop.some((pattern) => pattern.test(name))) return false
  return filter.keep.length === 0 || filter.keep.some((pattern) => pattern.test(name))
}

/** 过滤一台服务器的工具目录，同时报出被隐藏的数量。 */
export function filterTools<T extends { readonly name: string }>(
  tools: readonly T[],
  filter: ToolFilter,
): { visible: readonly T[]; hidden: number } {
  if (!filterHidesAnything(filter)) return { visible: tools, hidden: 0 }
  const visible = tools.filter((tool) => admits(filter, tool.name))
  return { visible, hidden: tools.length - visible.length }
}
