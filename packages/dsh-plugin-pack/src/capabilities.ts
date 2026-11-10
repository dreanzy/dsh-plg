/**
 * 宿主的支持面。
 *
 * 「宿主支持什么」是一个会随宿主版本变化的事实，而不是三个散落的状态：它决定面板标不
 * 标红、决定降级提示发不发、也决定本轮要不要改掩码。集中在这里，是为了让「关掉插件
 * 为什么只生效一半」有一个地方能回答。
 *
 * 两条探测纪律：
 * - 一旦确认支持就不再回退——旧宿主中途报错不该把标记翻回 false，否则面板会在支持与
 *   不支持之间闪。
 * - 取不到时按不支持显示：面板提示「已保存但不生效」，比误报支持安全。
 */

/** 宿主是否提供两条通道的能力，供面板标红。 */
export interface Support {
  readonly restrict: boolean
  readonly promptFilter: boolean
}

/** 宿主 tools 服务里与本判断有关的那一格。 */
interface RestrictFace {
  restrict?: unknown
}

export interface Capabilities {
  /** 本轮确认宿主支持 `tools.restrict`。只往 true 走，不会翻回。 */
  noteRestrict(found: boolean): void
  /** 本轮成功订阅过装配事件。 */
  notePromptFilter(found: boolean): void
  /** 同一条降级只提示一次：这些分支每次重算都会走到，逐次刷日志没有信息量。 */
  warnOnce(key: string, message: string): void
  /** 当前结论。取用时会再探一次根服务，所以面板与装配拿到的是同一个答案。 */
  support(): Support
}

export function createCapabilities(getToolsRoot: () => unknown, warn: (message: string) => void): Capabilities {
  let restrictFound = false
  let promptFilterFound = false
  const warned = new Set<string>()

  const probe = (): boolean => {
    try {
      const root = getToolsRoot()
      return typeof root === 'object' && root !== null && typeof (root as RestrictFace).restrict === 'function'
    } catch {
      return false
    }
  }

  return {
    noteRestrict(found) {
      if (found) restrictFound = true
    },
    notePromptFilter(found) {
      if (found) promptFilterFound = true
    },
    warnOnce(key, message) {
      if (warned.has(key)) return
      warned.add(key)
      warn(message)
    },
    support() {
      return { restrict: restrictFound || probe(), promptFilter: promptFilterFound }
    },
  }
}
